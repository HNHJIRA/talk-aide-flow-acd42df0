//==============================================================================
//  InterviewCopilot Virtual Microphone — CoreAudio AudioServerPlugIn
//
//  Publishes ONE virtual audio device named "InterviewCopilot Virtual
//  Microphone" with:
//
//     * an OUTPUT stream  — the InterviewCopilot Companion renders the
//       interpreted (translated TTS) voice into it, and
//     * an INPUT  stream  — Zoom / Teams / Google Meet / Chrome select it as a
//       microphone and hear exactly what was rendered.
//
//  The two streams are joined by a lock-free ring buffer keyed on the HAL
//  sample time, so no locks are taken on the realtime IO threads.
//
//  This driver is completely independent of the InterviewCopilot meeting
//  pipeline: it contains no capture code, no ScreenCaptureKit, no networking
//  and no dependency on the Companion process. If the Companion is not
//  running the device simply produces silence.
//
//  Format: 48 kHz, mono, Float32 (the HAL's native mix format; clients that
//  ask for 16-bit PCM are converted by CoreAudio transparently).
//==============================================================================

#include <CoreAudio/AudioServerPlugIn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>

#pragma mark - Configuration

#define kDeviceName             "InterviewCopilot Virtual Microphone"
#define kDeviceManufacturer     "InterviewCopilot"
#define kDeviceUID              "com.interviewcopilot.virtualmic.device"
#define kDeviceModelUID         "com.interviewcopilot.virtualmic.model"
#define kBoxUID                 "com.interviewcopilot.virtualmic.box"
#define kPlugInBundleID         "com.interviewcopilot.virtualmic"

#define kSampleRate             48000.0
#define kChannelCount           1
#define kRingFrames             65536          /* power of two, ~1.36 s mono */
#define kRingMask               (kRingFrames - 1)
#define kSafetyOffsetFrames     512
#define kZeroTimeStampPeriod    2048

enum {
    kObjectID_PlugIn        = kAudioObjectPlugInObject,
    kObjectID_Box           = 2,
    kObjectID_Device        = 3,
    kObjectID_Stream_Input  = 4,
    kObjectID_Stream_Output = 5
};

#pragma mark - State

static pthread_mutex_t  gStateMutex        = PTHREAD_MUTEX_INITIALIZER;
static AudioServerPlugInHostRef gHost      = NULL;
static UInt32           gRefCount          = 0;
static Boolean          gBoxAcquired       = true;
static UInt32           gDeviceIORunning   = 0;

/* Ring buffer shared by the output (write) and input (read) streams. Accessed
   only from realtime IO threads; each slot is written before it is read at the
   same sample time, so relaxed atomics on the samples are unnecessary. */
static Float32          gRing[kRingFrames];

/* Zero-timestamp bookkeeping (host-clock derived, standard HAL pattern). */
static Float64          gHostTicksPerFrame = 0.0;
static UInt64           gNumberTimeStamps  = 0;
static Float64          gAnchorHostTime    = 0.0;

static inline void ICA_EnsureHostTicks(void)
{
    if (gHostTicksPerFrame == 0.0) {
        struct mach_timebase_info info;
        mach_timebase_info(&info);
        Float64 hostClockFrequency =
            ((Float64)info.denom / (Float64)info.numer) * 1000000000.0;
        gHostTicksPerFrame = hostClockFrequency / kSampleRate;
    }
}

#pragma mark - Prototypes

static HRESULT  ICA_QueryInterface(void* inDriver, REFIID inUUID, LPVOID* outInterface);
static ULONG    ICA_AddRef(void* inDriver);
static ULONG    ICA_Release(void* inDriver);
static OSStatus ICA_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost);
static OSStatus ICA_CreateDevice(AudioServerPlugInDriverRef inDriver, CFDictionaryRef inDescription, const AudioServerPlugInClientInfo* inClientInfo, AudioObjectID* outDeviceObjectID);
static OSStatus ICA_DestroyDevice(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID);
static OSStatus ICA_AddDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo* inClientInfo);
static OSStatus ICA_RemoveDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo* inClientInfo);
static OSStatus ICA_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void* inChangeInfo);
static OSStatus ICA_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void* inChangeInfo);
static Boolean  ICA_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress);
static OSStatus ICA_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, Boolean* outIsSettable);
static OSStatus ICA_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32* outDataSize);
static OSStatus ICA_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32 inDataSize, UInt32* outDataSize, void* outData);
static OSStatus ICA_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32 inDataSize, const void* inData);
static OSStatus ICA_StartIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID);
static OSStatus ICA_StopIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID);
static OSStatus ICA_GetZeroTimeStamp(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed);
static OSStatus ICA_WillDoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, Boolean* outWillDo, Boolean* outWillDoInPlace);
static OSStatus ICA_BeginIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo);
static OSStatus ICA_DoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, AudioObjectID inStreamObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo, void* ioMainBuffer, void* ioSecondaryBuffer);
static OSStatus ICA_EndIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo);

#pragma mark - Interface table

static AudioServerPlugInDriverInterface gInterface = {
    NULL,
    ICA_QueryInterface,
    ICA_AddRef,
    ICA_Release,
    ICA_Initialize,
    ICA_CreateDevice,
    ICA_DestroyDevice,
    ICA_AddDeviceClient,
    ICA_RemoveDeviceClient,
    ICA_PerformDeviceConfigurationChange,
    ICA_AbortDeviceConfigurationChange,
    ICA_HasProperty,
    ICA_IsPropertySettable,
    ICA_GetPropertyDataSize,
    ICA_GetPropertyData,
    ICA_SetPropertyData,
    ICA_StartIO,
    ICA_StopIO,
    ICA_GetZeroTimeStamp,
    ICA_WillDoIOOperation,
    ICA_BeginIOOperation,
    ICA_DoIOOperation,
    ICA_EndIOOperation
};

static AudioServerPlugInDriverInterface* gInterfacePtr = &gInterface;
static AudioServerPlugInDriverRef gDriverRef = &gInterfacePtr;

#pragma mark - Factory (referenced from Info.plist CFPlugInFactories)

void* ICA_Create(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID);

void* ICA_Create(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID)
{
#pragma unused(inAllocator)
    if (!CFEqual(inRequestedTypeUUID, kAudioServerPlugInTypeUUID)) {
        return NULL;
    }
    return gDriverRef;
}

#pragma mark - COM plumbing

static HRESULT ICA_QueryInterface(void* inDriver, REFIID inUUID, LPVOID* outInterface)
{
    if (inDriver != gDriverRef || outInterface == NULL) {
        return kAudioHardwareIllegalOperationError;
    }
    CFUUIDRef requested = CFUUIDCreateFromUUIDBytes(NULL, inUUID);
    HRESULT result = E_NOINTERFACE;
    if (CFEqual(requested, IUnknownUUID) ||
        CFEqual(requested, kAudioServerPlugInDriverInterfaceUUID)) {
        pthread_mutex_lock(&gStateMutex);
        ++gRefCount;
        pthread_mutex_unlock(&gStateMutex);
        *outInterface = gDriverRef;
        result = S_OK;
    }
    CFRelease(requested);
    return result;
}

static ULONG ICA_AddRef(void* inDriver)
{
    if (inDriver != gDriverRef) return 0;
    pthread_mutex_lock(&gStateMutex);
    if (gRefCount < UINT32_MAX) ++gRefCount;
    ULONG value = gRefCount;
    pthread_mutex_unlock(&gStateMutex);
    return value;
}

static ULONG ICA_Release(void* inDriver)
{
    if (inDriver != gDriverRef) return 0;
    pthread_mutex_lock(&gStateMutex);
    if (gRefCount > 0) --gRefCount;
    ULONG value = gRefCount;
    pthread_mutex_unlock(&gStateMutex);
    return value;
}

#pragma mark - Lifecycle

static OSStatus ICA_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost)
{
    if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
    gHost = inHost;
    ICA_EnsureHostTicks();
    memset(gRing, 0, sizeof(gRing));
    return noErr;
}

/* The device is static: creation/destruction by the HAL is not supported. */
static OSStatus ICA_CreateDevice(AudioServerPlugInDriverRef inDriver, CFDictionaryRef inDescription, const AudioServerPlugInClientInfo* inClientInfo, AudioObjectID* outDeviceObjectID)
{
#pragma unused(inDriver, inDescription, inClientInfo, outDeviceObjectID)
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus ICA_DestroyDevice(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID)
{
#pragma unused(inDriver, inDeviceObjectID)
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus ICA_AddDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo* inClientInfo)
{
#pragma unused(inDriver, inDeviceObjectID, inClientInfo)
    return noErr;
}

static OSStatus ICA_RemoveDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo* inClientInfo)
{
#pragma unused(inDriver, inDeviceObjectID, inClientInfo)
    return noErr;
}

static OSStatus ICA_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void* inChangeInfo)
{
#pragma unused(inDriver, inDeviceObjectID, inChangeAction, inChangeInfo)
    return noErr;
}

static OSStatus ICA_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void* inChangeInfo)
{
#pragma unused(inDriver, inDeviceObjectID, inChangeAction, inChangeInfo)
    return noErr;
}

#pragma mark - Helpers

static void ICA_FillStreamFormat(AudioStreamBasicDescription* outFormat)
{
    memset(outFormat, 0, sizeof(AudioStreamBasicDescription));
    outFormat->mSampleRate       = kSampleRate;
    outFormat->mFormatID         = kAudioFormatLinearPCM;
    outFormat->mFormatFlags      = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
    outFormat->mBytesPerPacket   = 4 * kChannelCount;
    outFormat->mFramesPerPacket  = 1;
    outFormat->mBytesPerFrame    = 4 * kChannelCount;
    outFormat->mChannelsPerFrame = kChannelCount;
    outFormat->mBitsPerChannel   = 32;
}

static Boolean ICA_IsStream(AudioObjectID inObjectID)
{
    return inObjectID == kObjectID_Stream_Input || inObjectID == kObjectID_Stream_Output;
}

#pragma mark - Property queries

static Boolean ICA_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress)
{
#pragma unused(inDriver, inClientPID)
    if (inAddress == NULL) return false;
    UInt32 size = 0;
    return ICA_GetPropertyDataSize(gDriverRef, inObjectID, inClientPID, inAddress, 0, NULL, &size) == noErr;
}

static OSStatus ICA_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, Boolean* outIsSettable)
{
#pragma unused(inDriver, inObjectID, inClientPID)
    if (inAddress == NULL || outIsSettable == NULL) return kAudioHardwareIllegalOperationError;
    /* Everything this driver publishes is read-only: one fixed-format device. */
    *outIsSettable = false;
    return noErr;
}

static OSStatus ICA_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32* outDataSize)
{
#pragma unused(inDriver, inClientPID, inQualifierDataSize, inQualifierData)
    if (inAddress == NULL || outDataSize == NULL) return kAudioHardwareIllegalOperationError;

    switch (inObjectID) {
        case kObjectID_PlugIn:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:            *outDataSize = sizeof(AudioClassID); return noErr;
                case kAudioObjectPropertyOwner:            *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioObjectPropertyManufacturer:     *outDataSize = sizeof(CFStringRef); return noErr;
                case kAudioObjectPropertyOwnedObjects:     *outDataSize = 2 * sizeof(AudioObjectID); return noErr;
                case kAudioPlugInPropertyBoxList:          *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioPlugInPropertyTranslateUIDToBox:*outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioPlugInPropertyDeviceList:       *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioPlugInPropertyTranslateUIDToDevice: *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioPlugInPropertyResourceBundle:   *outDataSize = sizeof(CFStringRef); return noErr;
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Box:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:            *outDataSize = sizeof(AudioClassID); return noErr;
                case kAudioObjectPropertyOwner:            *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioObjectPropertyName:
                case kAudioObjectPropertyModelName:
                case kAudioObjectPropertyManufacturer:
                case kAudioObjectPropertySerialNumber:
                case kAudioObjectPropertyFirmwareVersion:
                case kAudioBoxPropertyBoxUID:              *outDataSize = sizeof(CFStringRef); return noErr;
                case kAudioObjectPropertyOwnedObjects:     *outDataSize = 0; return noErr;
                case kAudioBoxPropertyTransportType:       *outDataSize = sizeof(UInt32); return noErr;
                case kAudioBoxPropertyHasAudio:
                case kAudioBoxPropertyHasVideo:
                case kAudioBoxPropertyHasMIDI:
                case kAudioBoxPropertyIsProtected:
                case kAudioBoxPropertyAcquired:            *outDataSize = sizeof(UInt32); return noErr;
                case kAudioBoxPropertyDeviceList:          *outDataSize = gBoxAcquired ? sizeof(AudioObjectID) : 0; return noErr;
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Device:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:            *outDataSize = sizeof(AudioClassID); return noErr;
                case kAudioObjectPropertyOwner:            *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioObjectPropertyName:
                case kAudioObjectPropertyModelName:
                case kAudioObjectPropertyManufacturer:
                case kAudioDevicePropertyDeviceUID:
                case kAudioDevicePropertyModelUID:         *outDataSize = sizeof(CFStringRef); return noErr;
                case kAudioObjectPropertyOwnedObjects:
                case kAudioDevicePropertyStreams:
                    switch (inAddress->mScope) {
                        case kAudioObjectPropertyScopeInput:
                        case kAudioObjectPropertyScopeOutput: *outDataSize = sizeof(AudioObjectID); return noErr;
                        default: *outDataSize = 2 * sizeof(AudioObjectID); return noErr;
                    }
                case kAudioDevicePropertyTransportType:
                case kAudioDevicePropertyClockDomain:
                case kAudioDevicePropertyDeviceIsAlive:
                case kAudioDevicePropertyDeviceIsRunning:
                case kAudioDevicePropertyDeviceCanBeDefaultDevice:
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
                case kAudioDevicePropertyLatency:
                case kAudioDevicePropertySafetyOffset:
                case kAudioDevicePropertyZeroTimeStampPeriod:
                case kAudioDevicePropertyIsHidden:         *outDataSize = sizeof(UInt32); return noErr;
                case kAudioDevicePropertyNominalSampleRate: *outDataSize = sizeof(Float64); return noErr;
                case kAudioDevicePropertyAvailableNominalSampleRates: *outDataSize = sizeof(AudioValueRange); return noErr;
                case kAudioDevicePropertyPreferredChannelsForStereo: *outDataSize = 2 * sizeof(UInt32); return noErr;
                case kAudioDevicePropertyStreamConfiguration:
                    *outDataSize = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
                    return noErr;
                case kAudioObjectPropertyControlList:      *outDataSize = 0; return noErr;
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass:
                case kAudioObjectPropertyClass:            *outDataSize = sizeof(AudioClassID); return noErr;
                case kAudioObjectPropertyOwner:            *outDataSize = sizeof(AudioObjectID); return noErr;
                case kAudioObjectPropertyName:             *outDataSize = sizeof(CFStringRef); return noErr;
                case kAudioObjectPropertyOwnedObjects:     *outDataSize = 0; return noErr;
                case kAudioStreamPropertyIsActive:
                case kAudioStreamPropertyDirection:
                case kAudioStreamPropertyTerminalType:
                case kAudioStreamPropertyStartingChannel:
                case kAudioStreamPropertyLatency:          *outDataSize = sizeof(UInt32); return noErr;
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat:   *outDataSize = sizeof(AudioStreamBasicDescription); return noErr;
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats: *outDataSize = sizeof(AudioStreamRangedDescription); return noErr;
                default: return kAudioHardwareUnknownPropertyError;
            }

        default:
            return kAudioHardwareBadObjectError;
    }
}

static OSStatus ICA_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32 inDataSize, UInt32* outDataSize, void* outData)
{
#pragma unused(inDriver, inClientPID)
    if (inAddress == NULL || outDataSize == NULL || outData == NULL) {
        return kAudioHardwareIllegalOperationError;
    }

    #define WRITE_U32(value)  do { if (inDataSize < sizeof(UInt32)) return kAudioHardwareBadPropertySizeError; \
                                   *((UInt32*)outData) = (UInt32)(value); *outDataSize = sizeof(UInt32); return noErr; } while (0)
    #define WRITE_ID(value)   do { if (inDataSize < sizeof(AudioObjectID)) return kAudioHardwareBadPropertySizeError; \
                                   *((AudioObjectID*)outData) = (AudioObjectID)(value); *outDataSize = sizeof(AudioObjectID); return noErr; } while (0)
    #define WRITE_STR(value)  do { if (inDataSize < sizeof(CFStringRef)) return kAudioHardwareBadPropertySizeError; \
                                   *((CFStringRef*)outData) = CFStringCreateWithCString(NULL, (value), kCFStringEncodingUTF8); \
                                   *outDataSize = sizeof(CFStringRef); return noErr; } while (0)

    switch (inObjectID) {

        case kObjectID_PlugIn:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass: WRITE_U32(kAudioObjectClassID);
                case kAudioObjectPropertyClass:     WRITE_U32(kAudioPlugInClassID);
                case kAudioObjectPropertyOwner:     WRITE_ID(kAudioObjectUnknown);
                case kAudioObjectPropertyManufacturer: WRITE_STR(kDeviceManufacturer);
                case kAudioObjectPropertyOwnedObjects: {
                    AudioObjectID ids[2] = { kObjectID_Box, kObjectID_Device };
                    UInt32 count = inDataSize / sizeof(AudioObjectID);
                    if (count > 2) count = 2;
                    memcpy(outData, ids, count * sizeof(AudioObjectID));
                    *outDataSize = count * sizeof(AudioObjectID);
                    return noErr;
                }
                case kAudioPlugInPropertyBoxList:   WRITE_ID(kObjectID_Box);
                case kAudioPlugInPropertyDeviceList: {
                    UInt32 count = (gBoxAcquired && inDataSize >= sizeof(AudioObjectID)) ? 1 : 0;
                    if (count) *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = count * sizeof(AudioObjectID);
                    return noErr;
                }
                case kAudioPlugInPropertyTranslateUIDToBox: {
                    if (inQualifierDataSize != sizeof(CFStringRef)) return kAudioHardwareBadPropertySizeError;
                    CFStringRef uid = *((CFStringRef*)inQualifierData);
                    CFStringRef ours = CFSTR(kBoxUID);
                    WRITE_ID(CFStringCompare(uid, ours, 0) == kCFCompareEqualTo ? kObjectID_Box : kAudioObjectUnknown);
                }
                case kAudioPlugInPropertyTranslateUIDToDevice: {
                    if (inQualifierDataSize != sizeof(CFStringRef)) return kAudioHardwareBadPropertySizeError;
                    CFStringRef uid = *((CFStringRef*)inQualifierData);
                    CFStringRef ours = CFSTR(kDeviceUID);
                    WRITE_ID(CFStringCompare(uid, ours, 0) == kCFCompareEqualTo ? kObjectID_Device : kAudioObjectUnknown);
                }
                case kAudioPlugInPropertyResourceBundle: WRITE_STR("");
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Box:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass: WRITE_U32(kAudioObjectClassID);
                case kAudioObjectPropertyClass:     WRITE_U32(kAudioBoxClassID);
                case kAudioObjectPropertyOwner:     WRITE_ID(kObjectID_PlugIn);
                case kAudioObjectPropertyName:      WRITE_STR(kDeviceName);
                case kAudioObjectPropertyModelName: WRITE_STR(kDeviceName);
                case kAudioObjectPropertyManufacturer: WRITE_STR(kDeviceManufacturer);
                case kAudioObjectPropertySerialNumber: WRITE_STR("1");
                case kAudioObjectPropertyFirmwareVersion: WRITE_STR("1.0");
                case kAudioBoxPropertyBoxUID:       WRITE_STR(kBoxUID);
                case kAudioObjectPropertyOwnedObjects: *outDataSize = 0; return noErr;
                case kAudioBoxPropertyTransportType: WRITE_U32(kAudioDeviceTransportTypeVirtual);
                case kAudioBoxPropertyHasAudio:     WRITE_U32(1);
                case kAudioBoxPropertyHasVideo:
                case kAudioBoxPropertyHasMIDI:
                case kAudioBoxPropertyIsProtected:  WRITE_U32(0);
                case kAudioBoxPropertyAcquired:     WRITE_U32(gBoxAcquired ? 1 : 0);
                case kAudioBoxPropertyDeviceList: {
                    UInt32 count = (gBoxAcquired && inDataSize >= sizeof(AudioObjectID)) ? 1 : 0;
                    if (count) *((AudioObjectID*)outData) = kObjectID_Device;
                    *outDataSize = count * sizeof(AudioObjectID);
                    return noErr;
                }
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Device:
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass: WRITE_U32(kAudioObjectClassID);
                case kAudioObjectPropertyClass:     WRITE_U32(kAudioDeviceClassID);
                case kAudioObjectPropertyOwner:     WRITE_ID(kObjectID_PlugIn);
                case kAudioObjectPropertyName:      WRITE_STR(kDeviceName);
                case kAudioObjectPropertyModelName: WRITE_STR(kDeviceName);
                case kAudioObjectPropertyManufacturer: WRITE_STR(kDeviceManufacturer);
                case kAudioDevicePropertyDeviceUID: WRITE_STR(kDeviceUID);
                case kAudioDevicePropertyModelUID:  WRITE_STR(kDeviceModelUID);
                case kAudioObjectPropertyOwnedObjects:
                case kAudioDevicePropertyStreams: {
                    AudioObjectID ids[2];
                    UInt32 available = 0;
                    switch (inAddress->mScope) {
                        case kAudioObjectPropertyScopeInput:
                            ids[0] = kObjectID_Stream_Input; available = 1; break;
                        case kAudioObjectPropertyScopeOutput:
                            ids[0] = kObjectID_Stream_Output; available = 1; break;
                        default:
                            ids[0] = kObjectID_Stream_Input;
                            ids[1] = kObjectID_Stream_Output; available = 2; break;
                    }
                    UInt32 count = inDataSize / sizeof(AudioObjectID);
                    if (count > available) count = available;
                    memcpy(outData, ids, count * sizeof(AudioObjectID));
                    *outDataSize = count * sizeof(AudioObjectID);
                    return noErr;
                }
                case kAudioDevicePropertyTransportType: WRITE_U32(kAudioDeviceTransportTypeVirtual);
                case kAudioDevicePropertyClockDomain:   WRITE_U32(0);
                case kAudioDevicePropertyDeviceIsAlive: WRITE_U32(1);
                case kAudioDevicePropertyDeviceIsRunning: WRITE_U32(gDeviceIORunning > 0 ? 1 : 0);
                case kAudioDevicePropertyDeviceCanBeDefaultDevice: WRITE_U32(1);
                case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice: WRITE_U32(0);
                case kAudioDevicePropertyLatency:       WRITE_U32(0);
                case kAudioDevicePropertySafetyOffset:  WRITE_U32(kSafetyOffsetFrames);
                case kAudioDevicePropertyZeroTimeStampPeriod: WRITE_U32(kZeroTimeStampPeriod);
                case kAudioDevicePropertyIsHidden:      WRITE_U32(0);
                case kAudioDevicePropertyNominalSampleRate: {
                    if (inDataSize < sizeof(Float64)) return kAudioHardwareBadPropertySizeError;
                    *((Float64*)outData) = kSampleRate;
                    *outDataSize = sizeof(Float64);
                    return noErr;
                }
                case kAudioDevicePropertyAvailableNominalSampleRates: {
                    if (inDataSize < sizeof(AudioValueRange)) { *outDataSize = 0; return noErr; }
                    AudioValueRange range = { kSampleRate, kSampleRate };
                    memcpy(outData, &range, sizeof(range));
                    *outDataSize = sizeof(AudioValueRange);
                    return noErr;
                }
                case kAudioDevicePropertyPreferredChannelsForStereo: {
                    if (inDataSize < 2 * sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
                    ((UInt32*)outData)[0] = 1;
                    ((UInt32*)outData)[1] = kChannelCount; /* mono device: both map to ch 1 */
                    *outDataSize = 2 * sizeof(UInt32);
                    return noErr;
                }
                case kAudioDevicePropertyStreamConfiguration: {
                    UInt32 needed = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
                    if (inDataSize < needed) return kAudioHardwareBadPropertySizeError;
                    AudioBufferList* list = (AudioBufferList*)outData;
                    list->mNumberBuffers = 1;
                    list->mBuffers[0].mNumberChannels = kChannelCount;
                    list->mBuffers[0].mDataByteSize   = 0;
                    list->mBuffers[0].mData           = NULL;
                    *outDataSize = needed;
                    return noErr;
                }
                case kAudioObjectPropertyControlList: *outDataSize = 0; return noErr;
                default: return kAudioHardwareUnknownPropertyError;
            }

        case kObjectID_Stream_Input:
        case kObjectID_Stream_Output: {
            Boolean isInput = (inObjectID == kObjectID_Stream_Input);
            switch (inAddress->mSelector) {
                case kAudioObjectPropertyBaseClass: WRITE_U32(kAudioObjectClassID);
                case kAudioObjectPropertyClass:     WRITE_U32(kAudioStreamClassID);
                case kAudioObjectPropertyOwner:     WRITE_ID(kObjectID_Device);
                case kAudioObjectPropertyName:
                    WRITE_STR(isInput ? kDeviceName " Input" : kDeviceName " Output");
                case kAudioObjectPropertyOwnedObjects: *outDataSize = 0; return noErr;
                case kAudioStreamPropertyIsActive:  WRITE_U32(1);
                case kAudioStreamPropertyDirection: WRITE_U32(isInput ? 1 : 0);
                case kAudioStreamPropertyTerminalType:
                    WRITE_U32(isInput ? kAudioStreamTerminalTypeMicrophone : kAudioStreamTerminalTypeSpeaker);
                case kAudioStreamPropertyStartingChannel: WRITE_U32(1);
                case kAudioStreamPropertyLatency:   WRITE_U32(0);
                case kAudioStreamPropertyVirtualFormat:
                case kAudioStreamPropertyPhysicalFormat: {
                    if (inDataSize < sizeof(AudioStreamBasicDescription)) return kAudioHardwareBadPropertySizeError;
                    ICA_FillStreamFormat((AudioStreamBasicDescription*)outData);
                    *outDataSize = sizeof(AudioStreamBasicDescription);
                    return noErr;
                }
                case kAudioStreamPropertyAvailableVirtualFormats:
                case kAudioStreamPropertyAvailablePhysicalFormats: {
                    if (inDataSize < sizeof(AudioStreamRangedDescription)) { *outDataSize = 0; return noErr; }
                    AudioStreamRangedDescription ranged;
                    memset(&ranged, 0, sizeof(ranged));
                    ICA_FillStreamFormat(&ranged.mFormat);
                    ranged.mSampleRateRange.mMinimum = kSampleRate;
                    ranged.mSampleRateRange.mMaximum = kSampleRate;
                    memcpy(outData, &ranged, sizeof(ranged));
                    *outDataSize = sizeof(ranged);
                    return noErr;
                }
                default: return kAudioHardwareUnknownPropertyError;
            }
        }

        default:
            return kAudioHardwareBadObjectError;
    }

    #undef WRITE_U32
    #undef WRITE_ID
    #undef WRITE_STR
}

static OSStatus ICA_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientPID, const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize, const void* inQualifierData, UInt32 inDataSize, const void* inData)
{
#pragma unused(inDriver, inClientPID, inQualifierDataSize, inQualifierData, inDataSize, inData)
    if (inAddress == NULL) return kAudioHardwareIllegalOperationError;
    if (inObjectID != kObjectID_PlugIn && inObjectID != kObjectID_Box &&
        inObjectID != kObjectID_Device && !ICA_IsStream(inObjectID)) {
        return kAudioHardwareBadObjectError;
    }
    /* Fixed-format device — nothing is settable. */
    return kAudioHardwareUnsupportedOperationError;
}

#pragma mark - IO

static OSStatus ICA_StartIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID)
{
#pragma unused(inDriver, inClientID)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    pthread_mutex_lock(&gStateMutex);
    if (gDeviceIORunning == 0) {
        ICA_EnsureHostTicks();
        gNumberTimeStamps = 0;
        gAnchorHostTime   = (Float64)mach_absolute_time();
        memset(gRing, 0, sizeof(gRing));
    }
    ++gDeviceIORunning;
    pthread_mutex_unlock(&gStateMutex);
    return noErr;
}

static OSStatus ICA_StopIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID)
{
#pragma unused(inDriver, inClientID)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    pthread_mutex_lock(&gStateMutex);
    if (gDeviceIORunning > 0) --gDeviceIORunning;
    pthread_mutex_unlock(&gStateMutex);
    return noErr;
}

static OSStatus ICA_GetZeroTimeStamp(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed)
{
#pragma unused(inDriver, inClientID)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    if (outSampleTime == NULL || outHostTime == NULL || outSeed == NULL) {
        return kAudioHardwareIllegalOperationError;
    }

    pthread_mutex_lock(&gStateMutex);
    ICA_EnsureHostTicks();
    Float64 ticksPerPeriod = gHostTicksPerFrame * (Float64)kZeroTimeStampPeriod;
    Float64 now            = (Float64)mach_absolute_time();
    Float64 nextAnchor     = gAnchorHostTime + ticksPerPeriod * (Float64)(gNumberTimeStamps + 1);
    if (now >= nextAnchor) {
        ++gNumberTimeStamps;
    }
    *outSampleTime = (Float64)(gNumberTimeStamps * kZeroTimeStampPeriod);
    *outHostTime   = (UInt64)(gAnchorHostTime + ticksPerPeriod * (Float64)gNumberTimeStamps);
    *outSeed       = 1;
    pthread_mutex_unlock(&gStateMutex);
    return noErr;
}

static OSStatus ICA_WillDoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, Boolean* outWillDo, Boolean* outWillDoInPlace)
{
#pragma unused(inDriver, inClientID)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    Boolean willDo = false, inPlace = true;
    switch (inOperationID) {
        case kAudioServerPlugInIOOperationReadInput:
        case kAudioServerPlugInIOOperationWriteMix:
            willDo = true; inPlace = true; break;
        default:
            break;
    }
    if (outWillDo) *outWillDo = willDo;
    if (outWillDoInPlace) *outWillDoInPlace = inPlace;
    return noErr;
}

static OSStatus ICA_BeginIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo)
{
#pragma unused(inDriver, inClientID, inOperationID, inIOBufferFrameSize, inIOCycleInfo)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    return noErr;
}

/* Loopback: the Companion's rendered interpreter voice (WriteMix) lands in the
   ring; meeting apps read the same sample positions back (ReadInput). */
static OSStatus ICA_DoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, AudioObjectID inStreamObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo, void* ioMainBuffer, void* ioSecondaryBuffer)
{
#pragma unused(inDriver, inStreamObjectID, inClientID, ioSecondaryBuffer)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    if (ioMainBuffer == NULL || inIOBufferFrameSize == 0) return noErr;

    Float32* buffer = (Float32*)ioMainBuffer;

    if (inOperationID == kAudioServerPlugInIOOperationWriteMix) {
        UInt64 start = (UInt64)inIOCycleInfo->mOutputTime.mSampleTime;
        for (UInt32 frame = 0; frame < inIOBufferFrameSize; ++frame) {
            gRing[(start + frame) & kRingMask] = buffer[frame * kChannelCount];
        }
        return noErr;
    }

    if (inOperationID == kAudioServerPlugInIOOperationReadInput) {
        UInt64 start = (UInt64)inIOCycleInfo->mInputTime.mSampleTime;
        for (UInt32 frame = 0; frame < inIOBufferFrameSize; ++frame) {
            UInt64 slot = (start + frame) & kRingMask;
            buffer[frame * kChannelCount] = gRing[slot];
            /* Consume: prevents stale audio looping if the writer stops. */
            gRing[slot] = 0.0f;
        }
        return noErr;
    }

    return noErr;
}

static OSStatus ICA_EndIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo)
{
#pragma unused(inDriver, inClientID, inOperationID, inIOBufferFrameSize, inIOCycleInfo)
    if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
    return noErr;
}
