# Interview Copilot

MASTER BUILD PROMPT — REAL-TIME AI INTERVIEW COPILOT FOR GOOGLE MEET + ZOOM

Build a production-ready SaaS application called:

InterviewCopilot

This application is a real-time AI interview practice and authorized interview/call assistance platform.

It must work particularly well with:

Google Meet in Google Chrome

Zoom Web in Google Chrome

Microsoft Teams Web where technically possible

ordinary microphone-only conversations

The application must NOT be a static prototype.

The core workflow must actually work:

MEETING AUDIO
+
USER MICROPHONE
↓
REAL-TIME TRANSCRIPTION
↓
SPEAKER IDENTIFICATION
↓
AUTOMATIC QUESTION DETECTION
↓
RESUME + JOB DESCRIPTION + CONVERSATION CONTEXT
↓
AI ANSWER GENERATION
↓
STREAM ANSWER TO SCREEN
↓
SAVE TRANSCRIPT + QUESTIONS + ANSWERS
↓
SESSION SUMMARY + NOTES

The product must be an original implementation and original visual design.

Do not copy Parakeet AI branding, logo, protected copy, or exact interface.

Do not implement hidden screen-share behavior, monitoring bypasses, proctoring evasion, detection avoidance, or features whose purpose is concealing the application from another participant.

The application should be designed for interview practice and interview/call assistance where use of an AI assistant is permitted.

VERY IMPORTANT FIRST PRIORITY

Do NOT build 20 beautiful pages while the actual real-time interview workflow remains fake.

The highest priority is this exact flow:

User signs in.

User uploads resume.

Resume text is processed.

User starts a session.

User connects microphone.

User connects Google Meet/Zoom Web meeting audio.

Remote meeting speech appears in transcript.

User microphone speech appears separately.

App recognizes which side is interviewer and which is candidate.

Interviewer asks a question.

App automatically detects the question.

Relevant resume information is retrieved.

AI starts generating an answer automatically.

Answer streams onto screen.

Next interviewer question works without refreshing the page.

Session can run continuously for 30-60+ minutes.

Ending session correctly closes audio streams and sockets.

Transcript and answers are saved.

AI session notes are generated.

User can open session later from History.

Until this works, prioritize functionality over decorative features.

1. TARGET PLATFORM

Desktop Chrome should be the primary supported environment.

Optimize first for:

macOS + Chrome

Windows + Chrome

Secondary:

Edge

other Chromium browsers

Mobile can support dashboard, history, practice, resume management and microphone-only sessions.

Do not promise complete meeting-audio capture on every browser.

Create capability detection.

At session startup check:

navigator.mediaDevices

getUserMedia availability

getDisplayMedia availability

audio track availability

browser family

operating system when available

secure HTTPS context

Show the user what is supported.

2. GOOGLE MEET SUPPORT

Google Meet is a PRIMARY use case.

The expected workflow:

User has Google Meet open in one Chrome tab.

InterviewCopilot is open in another tab/window.

Inside InterviewCopilot the user clicks:

CONNECT MEETING AUDIO

Use:

navigator.mediaDevices.getDisplayMedia()

Ask the user to explicitly choose the Google Meet browser tab.

Request:

video: true

audio: true

where supported.

The app only needs the audio track for transcription.

Once permission succeeds:

inspect stream.getAudioTracks()

verify at least one audio track exists

show Meeting Audio Connected

do not silently pretend audio is available

stop/discard video processing if video is not needed

keep the audio track active

detect track ending

detect browser share stopping

Give UI instructions:

"For best Google Meet results, select the Google Meet tab and enable Share tab audio."

Show these status indicators:

MICROPHONE
Connected / Not Connected

MEETING AUDIO
Connected / Not Connected

TRANSCRIPTION
Active / Connecting / Error

AI
Ready / Generating / Error

If the user selects a Meet tab but no audio track is provided, display:

"No meeting audio was received. Reconnect and make sure tab audio sharing is enabled."

Do not fake successful status.

3. ZOOM WEB SUPPORT

Zoom Web in Chrome should work using essentially the same workflow.

User joins Zoom using the Zoom web client.

User opens InterviewCopilot separately.

When starting the copilot:

CONNECT MEETING AUDIO

Use getDisplayMedia.

Ask user to select the Zoom browser tab and share its audio.

Treat Zoom Web remote audio as:

source = remote_meeting

Treat microphone as:

source = local_microphone

Keep the streams separate.

Do NOT combine them immediately into one audio stream.

Separate streams are important for speaker detection.

4. ZOOM DESKTOP APP SUPPORT

A normal web application cannot guarantee access to Zoom Desktop application audio on every OS/browser configuration.

Therefore implement a capability-based flow.

Button:

CONNECT ZOOM DESKTOP AUDIO

Attempt user-authorized display/system/window audio capture where browser and OS support it.

After getDisplayMedia returns:

check:

displayStream.getAudioTracks().length

If > 0:

show:

Zoom Audio Connected

If 0:

do NOT show success.

Display:

"Your browser/operating system did not provide Zoom audio. For the most reliable experience, join the meeting through Zoom Web in Chrome."

Also offer:

MICROPHONE-ONLY MODE

Never fabricate Zoom Desktop support.

5. FUTURE CHROME EXTENSION ARCHITECTURE

The main SaaS must work without an extension first.

After the web version works, prepare the architecture for an optional Chrome extension.

Create documentation and an API interface for a future extension.

The extension may use:

chrome.tabCapture

for user-approved capture of:

Google Meet tab audio

Zoom Web tab audio

The extension must only begin capture after an explicit user action such as clicking:

START COPILOT

Do not make audio capture hidden.

Do not require the extension for MVP.

The main application should still work through getDisplayMedia.

6. AUDIO ARCHITECTURE

This part is critical.

Maintain TWO independent audio sources wherever possible.

SOURCE A:

REMOTE MEETING AUDIO

Examples:

Google Meet tab
Zoom Web tab
shared meeting window/system audio

Label:

interviewer

SOURCE B:

LOCAL MICROPHONE

Label:

candidate

Do NOT simply mix everything before transcription.

Use two transcription pipelines whenever practical.

Example:

Google Meet audio
↓
Remote STT session
↓
interviewer transcript

Microphone
↓
Local STT session
↓
candidate transcript

Then merge transcript events chronologically in UI/database.

This gives significantly cleaner question detection.

7. AUDIO FEEDBACK / ECHO

Prevent candidate microphone audio from being re-transcribed as remote audio where possible.

Do not route captured meeting audio back into an additional speaker output unless required.

Use appropriate Web Audio API behavior.

For microphone constraints request where available:

echoCancellation: true
noiseSuppression: true
autoGainControl: true

Allow user to disable these in advanced settings.

8. AUDIO LEVEL METERS

Create separate live input meters.

Meeting Audio:

████████░░

Microphone:

██████░░░░

Use Web Audio API:

AudioContext
AnalyserNode

The meters must represent real audio.

If audio level remains nearly zero for several seconds:

show:

"We're connected but cannot hear audio."

Do not automatically disconnect.

9. AUDIO DEVICE SELECTION

Allow selection of microphone.

Use:

navigator.mediaDevices.enumerateDevices()

Show available:

audioinput devices

Example:

MacBook Microphone
AirPods Microphone
External USB Microphone

Remember selected device in user preferences.

Handle device disconnection.

10. TRANSCRIPTION ENGINE

Use a real streaming speech-to-text provider.

Preferred:

Deepgram streaming transcription

Create secure server functionality to authorize/initiate transcription without exposing the permanent Deepgram secret.

Never put DEEPGRAM_API_KEY directly into frontend JavaScript.

Store it in:

Lovable Cloud Secrets
or
Supabase Edge Function secrets.

Create server function:

create-stt-session

Authenticated users only.

Architecture:

Audio Stream
↓
Streaming STT WebSocket
↓
Partial Transcript
↓
Final Transcript

Support interim transcription.

Example:

interim:

"tell me about your exper..."

final:

"Tell me about your experience with React."

Only save FINAL transcript segments in database.

Interim segments should normally remain in local application state.

11. DUAL TRANSCRIPTION

When meeting audio and microphone are connected:

Remote STT connection:

source: remote
speaker: interviewer

Local STT connection:

source: microphone
speaker: candidate

Maintain separate WebSocket/state objects.

Do not accidentally create new WebSockets after every React rerender.

Use refs/services with explicit lifecycle control.

There should never be multiple unintended transcription sessions for the same source.

12. STT RECONNECT

Interview sessions may last a long time.

Implement resilient reconnection.

If an STT WebSocket disconnects:

show:

Reconnecting...

Attempt safe reconnection.

Use exponential backoff with sensible maximum.

Do not duplicate final transcript after reconnecting.

Track segment IDs/timestamps.

If remote STT fails but microphone STT remains active:

do not kill the entire session.

Show per-source status.

13. TRANSCRIPT DATA MODEL

Create table:

transcript_segments

Fields:

id UUID
session_id UUID
user_id UUID
source text
speaker text
text text
is_final boolean
confidence numeric nullable
started_at_ms bigint nullable
ended_at_ms bigint nullable
sequence_number bigint
created_at timestamptz

source values:

remote_meeting
microphone
manual
unknown

speaker values:

interviewer
candidate
unknown

Add useful indexes.

14. QUESTION DETECTION

Question detection must be AUTOMATIC.

Only primarily run automatic question detection against:

speaker = interviewer

Do not generate responses to the candidate's own answer.

This is one major reason separate audio streams are required.

Examples that MUST trigger:

"Tell me about yourself."

"Can you walk me through your experience with React?"

"Why do you want this position?"

"What was your role on that project?"

"Explain dependency injection."

"How would you design a scalable notification service?"

"What happened when the deployment failed?"

"Walk me through how you would approach this."

Examples that should NOT normally trigger:

"Okay."

"Interesting."

"Right."

"That makes sense."

"We mainly use AWS."

"I worked at the company for five years."

Use an inexpensive, low-latency classifier.

Return strict structured JSON:

{
"is_question": true,
"question": "Tell me about your React experience.",
"category": "technical",
"confidence": 0.96,
"requires_answer": true
}

Only auto-generate above a configured confidence threshold.

Default:

0.78

Make threshold configurable by admin/debug settings.

15. QUESTION TYPES

Support:

intro
resume
behavioral
situational
technical
coding
system_design
leadership
management
product
sales
culture
salary
availability
follow_up
clarification
general

Store question category.

16. DUPLICATE QUESTION PROTECTION

Streaming transcription creates evolving sentences.

Example:

Partial:

"Tell me about..."

Then:

"Tell me about your React..."

Then final:

"Tell me about your React experience."

This must create ONE detected question.

Implement question deduplication using:

normalized text

semantic/text similarity

recent time window

source transcript IDs

Do not automatically generate from early partial transcript unless strong endpoint detection exists.

Prefer final segments or stabilized utterances.

Create a short question stabilization delay approximately appropriate for natural conversation, but do not add excessive latency.

17. FOLLOW-UP QUESTION UNDERSTANDING

The AI must understand conversation context.

Example:

Interviewer:

"Tell me about the payment platform you built."

Later:

"What was the hardest part?"

The system must understand what "the hardest part" refers to.

Maintain:

recent transcript window
previous 3-5 questions
previous answer summaries
rolling session summary

Do not send a 60-minute transcript to the LLM for every question.

18. AI ENGINE

Use OpenAI through a Supabase Edge Function.

Recommended production architecture:

OpenAI Responses API

Allow model configuration through environment/server settings.

Default to an appropriate low-latency current GPT-5.6 family model such as:

gpt-5.6-terra

or a lower-cost/low-latency current model if testing proves better.

Do not hardcode the application's architecture around one permanent model name.

Store model selection server-side.

Create:

generate-interview-answer

Edge Function.

API key:

OPENAI_API_KEY

must remain server-side.

19. AI STREAMING

Answers MUST stream.

Do not wait for the entire response.

Expected UI:

Question detected

"Tell me about your React experience."

Thinking...

Then:

"I've worked extensively..."

continues token-by-token.

Implement Server-Sent Events or another appropriate streaming transport from Edge Function to frontend.

Provide:

Stop
Regenerate

Abort old request if new priority question requires generation.

20. AI RESPONSE LATENCY

This product is latency-sensitive.

Optimize for fast first useful text.

Target architecture:

Question finalized
<100ms
question UI displayed

Question classification
fast

Context retrieval
parallel where possible

AI request
immediate

First answer tokens displayed as soon as available.

Track:

speech finalization time
question detection time
retrieval time
AI request start
first token time
completion time

Create debug telemetry but hide it in normal mode.

21. AI RESPONSE STYLE

Answers are designed to be easy to scan.

Avoid giant essays.

Default:

50-120 words.

Use natural spoken English.

Prioritize:

direct opening answer

2-4 supporting points

a concrete example if grounded in user's documents

outcome where relevant

The user can select:

ULTRA SHORT
SHORT
NORMAL
DETAILED

22. ANSWER FORMATS

Support buttons:

QUICK ANSWER

STAR

TECHNICAL

MORE DETAIL

SHORTER

SIMPLER

EXPLAIN

REGENERATE

PIN

COPY

Formats:

QUICK

2-4 bullets.

NATURAL

Conversational short paragraph.

STAR

Situation
Task
Action
Result

TECHNICAL

Concept
Implementation
Example
Tradeoffs

LEADERSHIP

Context
Decision
Team Action
Result
Lesson

23. PERSONALIZATION

The AI answer must consider:

detected question
primary resume
job description
company
target position
user seniority
relevant uploaded documents
previous questions
recent transcript
answer style

Ranking:

factual user resume information

relevant supporting documents

supplied job description

conversation context

general knowledge

24. ABSOLUTELY NO EXPERIENCE FABRICATION

This is critical.

If resume says:

3 years React

do not say:

8 years React.

If resume does not say user generated $2 million:

do not invent that result.

If an exact personal example isn't available, provide an adaptable response framework.

Example:

Instead of inventing:

"At Google I managed a team of 20..."

say:

"A strong example here would be a project where you coordinated multiple stakeholders. Based on your resume, your [actual project] may be the closest fit..."

Internal server system instruction:

You are an interview coaching copilot.

Use the user's verified resume, documents and supplied context as the source of truth for personal background.

Never invent:
employers,
education,
degrees,
certifications,
project results,
revenue,
years of experience,
team size,
technologies,
job titles,
dates,
or accomplishments.

When required information is missing, provide a truthful framework rather than fabricated personal history.

Write responses that sound natural when spoken.

25. RESUME UPLOAD

Create:

/documents

Allow:

PDF
DOCX
TXT

Drag and drop.

Show:

filename
type
size
processing state
uploaded date

Statuses:

uploading
processing
ready
error

Allow:

Set as Primary Resume
Rename
Delete

26. DOCUMENT STORAGE

Use private Supabase Storage.

Bucket:

user-documents

Never public.

Path architecture:

user_id/resumes/file
user_id/supporting/file

RLS/storage policies must ensure users cannot access other users' files.

Use signed URLs only when needed.

27. DOCUMENT PROCESSING

After upload:

Save original file.

Extract text.

Clean text.

Detect sections.

Store extracted text.

Chunk text intelligently.

Create embeddings if pgvector is configured.

Mark ready.

For resume chunks identify where possible:

summary
skills
experience
job
projects
education
certifications
achievements

Do not rely only on arbitrary 1,000-character splitting.

28. DATABASE TABLES

Create:

profiles

Fields:

id
user_id
full_name
avatar_url
current_role
target_role
experience_level
preferred_language
default_answer_style
default_answer_length
created_at
updated_at

Create:

documents

Fields:

id
user_id
type
file_name
storage_path
extracted_text
processing_status
is_primary
metadata jsonb
created_at
updated_at

Create:

document_chunks

Fields:

id
document_id
user_id
content
chunk_type
chunk_index
embedding if pgvector available
metadata jsonb
created_at

Create:

interview_sessions

Fields:

id
user_id
title
meeting_platform
session_type
company_name
target_role
job_description
language
status
started_at
ended_at
duration_seconds
credits_used
created_at
updated_at

meeting_platform:

google_meet
zoom_web
zoom_desktop
teams_web
manual
practice

Create:

audio_sources

Fields:

id
session_id
user_id
source_type
device_label
status
started_at
ended_at
metadata jsonb

Create:

transcript_segments

as described previously.

Create:

detected_questions

Fields:

id
user_id
session_id
transcript_segment_id
question_text
normalized_question
category
confidence
status
created_at

status:

detected
generating
answered
dismissed
error

Create:

generated_answers

Fields:

id
user_id
session_id
question_id
answer_text
answer_style
model
generation_ms
first_token_ms
is_pinned
created_at

Create:

session_notes

Fields:

id
user_id
session_id
summary
questions_summary
strengths
improvement_areas
follow_up_topics
action_items
created_at

Create:

user_credits

Fields:

id
user_id
available_seconds
used_seconds
plan
subscription_status
updated_at

Create:

usage_events

Fields:

id
user_id
session_id
event_type
quantity
metadata
created_at

29. RLS

Enable Row Level Security on every private table.

Users can only access rows where:

auth.uid() = user_id

Do not trust user_id supplied by frontend.

Backend functions derive authenticated user ID from JWT/session.

Check related session ownership server-side.

Test data isolation using two user accounts.

Account A must NEVER access:

Account B resume
Account B transcript
Account B questions
Account B answers
Account B session
Account B credits

30. AUTH

Use Supabase Auth.

Support:

Email signup
Email login
Forgot password
Email verification
Google login if configured
Logout

Protected pages redirect unauthenticated users.

On registration automatically create profile + initial free credits.

31. ONBOARDING

After signup:

Step 1:

What role are you interviewing for?

Step 2:

Experience level:

Entry
Mid
Senior
Lead
Executive

Step 3:

Upload resume

Step 4:

Preferred answer length

Step 5:

Test microphone

Step 6:

Meeting platform

Google Meet
Zoom
Other

Then dashboard.

32. START SESSION FLOW

Create prominent:

START INTERVIEW COPILOT

Modal/wizard.

Step 1:

Meeting platform

Google Meet
Zoom Web
Zoom Desktop
Teams Web
Microphone Only

Step 2:

Interview type

General
Behavioral
Technical
Coding
Leadership
Sales
Custom

Step 3:

Role

Step 4:

Company optional

Step 5:

Paste job description optional

Step 6:

Choose resume

Default primary resume.

Step 7:

Answer settings

Quick
Natural
STAR
Technical

Step 8:

Audio Setup

Connect microphone.

Step 9:

Connect meeting audio.

Only then:

START SESSION

33. AUDIO SETUP SCREEN

Design a clear diagnostic screen.

Example:

MICROPHONE

MacBook Pro Microphone

● Connected

input meter

MEETING AUDIO

Google Meet

○ Not Connected

[ Connect Meeting Audio ]

Instructions:

Click Connect.

Choose your Google Meet tab.

Enable tab audio sharing.

Click Share.

After connection:

● Connected

input meter

AI

● Ready

TRANSCRIPTION

● Ready

Button:

START COPILOT

34. LIVE SESSION INTERFACE

Create:

/session/:sessionId

Desktop layout.

TOP BAR:

InterviewCopilot
Google Meet / Zoom
00:17:24

Meeting ●
Mic ●
STT ●
AI ●

Pause

End Session

LEFT SIDE — TRANSCRIPT

Approximately 35-40%.

Header:

LIVE TRANSCRIPT

Filter:

All
Interviewer
Me

Example:

INTERVIEWER
Tell me about your React experience.

YOU
I've mainly been working with React...

Use subtle timestamps.

Partial transcript visually lighter.

Final transcript solid.

Auto-scroll.

If user manually scrolls upward:

stop auto-scroll.

Show:

Jump to Live

button.

RIGHT SIDE — AI COPILOT

Approximately 60-65%.

Header:

AI COPILOT

Latest card:

QUESTION

Tell me about your React experience.

ANSWER

I've worked with React...

Stream live.

Buttons:

Shorter
STAR
More Detail
Technical
Regenerate
Copy
Pin

Below:

PREVIOUS QUESTIONS

Collapsible question cards.

35. NEW QUESTION BEHAVIOR

When interviewer finishes asking a question:

transcript finalizes

question detection runs

question appears

subtle notification animation

show "Generating..."

retrieve context

start answer stream

answer becomes primary

User should not press Generate manually.

Manual generation can exist as fallback.

36. RAPID FOLLOW-UP QUESTIONS

Suppose answer is still generating and interviewer asks another question.

Do not freeze.

Create new question.

If new question clearly supersedes previous one:

cancel previous streaming request using AbortController.

Otherwise save partial response and prioritize new question.

Previous question remains in history.

37. PAUSE

Pause should:

stop sending audio to STT

but should not lose session data.

Resume should safely reconnect.

Do not create duplicate WebSocket sessions after resume.

38. END SESSION

End Session confirmation:

End this session?

Buttons:

Cancel
End & Generate Notes

When ending:

stop MediaRecorder/audio processors
close microphone MediaStream tracks
close display MediaStream tracks
close STT WebSockets
abort active generations if appropriate
remove listeners
clear timers
save final duration
set status completed
generate notes

The browser microphone indicator should turn off after session ends.

39. SESSION NOTES

Automatically generate after session.

Sections:

SUMMARY

QUESTIONS ASKED

KEY TECHNICAL TOPICS

IMPORTANT DETAILS

STRONG RESPONSES

RESPONSES TO IMPROVE

FOLLOW-UP TOPICS

ACTION ITEMS

Store notes.

40. SESSION HISTORY

Create:

/history

Cards/table:

Date
Company
Position
Platform
Duration
Questions
Type

Filters:

All
Google Meet
Zoom
Practice
Technical
Behavioral

Search.

Click opens:

/history/:sessionId

Show full:

transcript
questions
answers
notes

41. DASHBOARD

Create clean SaaS dashboard.

Hero:

Ready for your next interview?

Primary:

START COPILOT

Secondary:

PRACTICE INTERVIEW

Cards:

Minutes Remaining
Sessions This Month
Questions Answered
Practice Score

Sections:

Recent Sessions
Primary Resume
Target Role
Quick Practice

42. PRACTICE MODE

Create:

/practice

AI behaves as interviewer.

Choose:

role
job description
experience
difficulty
interview type
number of questions

AI asks question.

Optional text-to-speech.

User answers through microphone.

STT transcribes candidate answer.

AI evaluates.

Score:

Relevance
Structure
Clarity
Specificity
Technical Accuracy

Provide:

What Was Good
What Could Improve
Better Answer Example

Then:

Next Question

This mode does not require Google Meet/Zoom.

43. CODING PRACTICE

Create:

/coding

User can:

paste coding question
upload screenshot/image
enter manually

AI output:

Problem Understanding
Clarifying Questions
Approach
Algorithm
Pseudocode
Code
Time Complexity
Space Complexity
Edge Cases
Alternative Approach

Languages:

JavaScript
TypeScript
Python
Java
C#
C++
Go
PHP

Modes:

Hint
Explain
Solve
Optimize
Debug

44. JOB DESCRIPTION

Allow JD to be:

pasted manually
uploaded as file

Use JD to influence answers.

Example:

If company asks for:

React
Node.js
AWS

and resume contains those skills:

prioritize relevant experience.

Do not invent missing requirements.

45. CONTEXT RETRIEVAL / RAG

Use semantic retrieval if possible.

For each question:

classify question

generate/search query

retrieve relevant resume chunks

retrieve supporting document chunks

include relevant JD sections

include recent conversation

send minimal relevant context to LLM

Do not send full resume + every document + full transcript on every request.

Use pgvector if available.

If vector search is not configured yet:

implement reliable keyword/full-text fallback rather than breaking the app.

46. ROLLING CONVERSATION SUMMARY

Every several minutes/questions update a compact session context summary.

Example internal data:

Current topic:
Previous project payment system.

Technologies discussed:
React, Node.js, Stripe, AWS.

Important facts:
Candidate led frontend integration.
Candidate implemented Stripe checkout.

Previous interviewer focus:
Scalability and failures.

This reduces token usage.

47. SESSION STATE MACHINE

Use an explicit state machine.

States:

idle

configuring

requesting_microphone

requesting_meeting_audio

ready

connecting_stt

listening

question_detected

generating

paused

reconnecting

ending

completed

error

Do not manage session behavior using dozens of contradictory booleans.

48. SOURCE STATES

Remote source state:

disconnected
connecting
active
silent
error

Microphone state:

disconnected
connecting
active
silent
error

STT states independently tracked.

49. NETWORK RECOVERY

Listen for online/offline state.

If internet disconnects:

show large but non-blocking:

Connection lost. Attempting to reconnect.

Keep already captured transcript in local state.

When connection returns:

reconnect safely.

Do not generate duplicate questions.

50. LONG SESSION RELIABILITY

Test at least conceptually/architecturally for:

5 minute
30 minute
60 minute

sessions.

Avoid memory leaks.

Remove old interim transcripts.

Virtualize long transcript lists if necessary.

Limit in-memory history while keeping persisted DB data.

Do not create one React component per token forever.

51. LATENCY UI

Use progressive states:

Listening...

Transcribing...

Question detected

Thinking...

Answer streaming

Ready

No blocking full-screen loaders.

52. BILLING

Add Stripe later after core audio flow works.

Plans:

FREE

Limited practice and limited copilot minutes.

PRO

Monthly minutes.

CREDITS

Additional minute packs.

Create:

/pricing

Use Stripe Checkout.

Secrets:

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

Payment validation MUST happen through verified webhooks.

Never add credits based only on redirect query parameters.

53. USAGE TRACKING

Track transcription/session usage server-side.

Deduct credits based on actual session/AI eligible duration.

Warnings:

10 minutes remaining

5 minutes remaining

1 minute remaining

Do not allow frontend user to modify their own credit balance.

54. SETTINGS

Create:

/settings

Tabs:

Profile

AI

Audio

Documents

Privacy

Billing

AI Settings:

Default answer length
Default answer style
Language
Technical depth
Use resume ON/OFF
Use job description ON/OFF
Auto-detect questions ON/OFF
Auto-generate answers ON/OFF

Audio:

Default microphone
Noise suppression
Echo cancellation
Auto gain
Connection test

55. LANGUAGES

Support architecture for:

English
Spanish
French
German
Italian
Portuguese
Hindi
Urdu
Arabic

Separate:

Transcription Language

Answer Language

Example:

Interview language:
English

Answer suggestions:
English

Or:

Interview:
English

Answer:
Urdu

56. DESIGN

Use a premium dark SaaS aesthetic.

Original design.

Background:

deep charcoal / near black / dark navy.

Accent:

electric blue
indigo
subtle cyan

Use:

clean typography
rounded 12-16px cards
subtle borders
minimal gradients
controlled shadows
generous whitespace
clear status colors
smooth animations

Do not overuse glassmorphism.

Readability matters more than decorative effects.

57. ANSWER READABILITY

This is important during calls.

Use larger answer font:

approximately 17-20px desktop depending layout.

Line height comfortable.

Bold key concepts sparingly.

Support optional:

Bullet Mode

which transforms an answer into 3-5 speaking points.

58. COMPACT SESSION WINDOW

Add a UI mode:

COMPACT VIEW

Within the browser application.

Compact View displays only:

Current Question
Current Answer
Mic status
Meeting audio status
Timer

This is simply a smaller application layout.

Do not implement concealment from screen sharing or monitoring software.

59. KEYBOARD SHORTCUTS

Useful shortcuts:

Cmd/Ctrl + Shift + S
Shorter

Cmd/Ctrl + Shift + R
Regenerate

Cmd/Ctrl + Shift + D
More Detail

Cmd/Ctrl + Shift + P
Pause

Escape
close modal

Do not hijack common browser shortcuts unnecessarily.

Show shortcuts in Settings.

60. BACKEND EDGE FUNCTIONS

Create modular functions:

create-stt-session

process-document

detect-question

retrieve-context

generate-interview-answer

generate-session-notes

evaluate-practice-answer

analyze-coding-question

create-checkout-session

stripe-webhook

delete-account

Avoid a giant single Edge Function.

61. GENERATE ANSWER ENDPOINT

Authenticated request:

{
"sessionId": "...",
"questionId": "...",
"answerStyle": "natural",
"answerLength": "short"
}

Server must retrieve:

authenticated user
session ownership
question
primary resume
job description
context

Do NOT accept arbitrary "resume text" supplied by browser as trusted personal context.

62. API SECURITY

Never expose:

OPENAI_API_KEY
DEEPGRAM_API_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

Frontend can only receive temporary/session credentials if specifically designed for secure client streaming.

Rate-limit expensive APIs.

Validate authentication.

Validate input.

Limit upload size.

Validate MIME types.

63. PRIVACY

Interview transcripts and resumes are sensitive.

Default:

do not store raw audio permanently.

Store:

transcript
questions
answers
notes

Only store raw audio if user explicitly enables:

Record Session Audio

and gives permission.

Clearly indicate recording state.

Provide:

Delete Transcript
Delete Session
Delete Resume
Delete Account

64. AUDIO CAPTURE DISCLOSURE

Always show visible audio status.

Example:

● Meeting audio active

● Microphone active

Never start audio capture without an explicit user interaction.

65. ADMIN

After main product works create:

/admin

Admin authorization must be backend-enforced.

Stats:

Users
Sessions
Minutes
STT usage
LLM requests
Failed transcriptions
Failed generations
Subscriptions
Revenue

Search user.

Do not expose resume content unnecessarily in admin overview.

66. ERROR STATES

Create polished recovery for:

Microphone denied

Meeting audio denied

No tab audio

Unsupported browser

STT API unavailable

AI unavailable

Network offline

Resume processing failure

Insufficient credits

Expired auth

Example:

MEETING AUDIO NOT FOUND

Your browser did not provide an audio track.

For Google Meet or Zoom Web:

Reconnect.

Select the meeting tab.

Make sure tab audio sharing is enabled.

[Reconnect]

67. GOOGLE MEET ACCEPTANCE TEST

This must pass.

Setup:

Chrome.

Tab 1:
Google Meet.

Tab 2:
InterviewCopilot.

Test:

Sign in.

Upload resume.

Start session.

Select Google Meet.

Connect microphone.

Click Connect Meeting Audio.

Chrome share dialog opens.

Select Google Meet tab.

Enable tab audio.

App verifies remote audio track.

Join/test conversation.

Remote participant says:

"Can you tell me about your React experience?"

Transcript should show:

INTERVIEWER:
Can you tell me about your React experience?

Question automatically detected.

No Generate click.

Relevant resume context retrieved.

AI answer starts streaming.

Candidate responds.

Candidate speech appears as:

YOU:

Candidate's own answer does NOT trigger another automatic AI answer.

Interviewer asks follow-up.

New answer generated.

End session.

Mic and display streams stop.

History contains session.

Do not mark Google Meet integration complete until this workflow is functional.

68. ZOOM WEB ACCEPTANCE TEST

Chrome.

Tab 1:
Zoom Web Client.

Tab 2:
InterviewCopilot.

Repeat same workflow.

Remote Zoom audio should appear as interviewer.

Microphone should appear as candidate.

Test:

"Walk me through your most recent project."

Question must automatically generate relevant answer.

69. ZOOM DESKTOP ACCEPTANCE TEST

Open Zoom Desktop.

Open InterviewCopilot in Chrome.

Click:

Connect Zoom Desktop Audio.

Ask user to choose appropriate screen/window audio source.

After permission:

inspect audio track.

If audio exists:

continue.

If browser returns no audio track:

display correct unsupported/fallback message.

Do NOT fake it.

Recommend:

"Use Zoom Web in Chrome for the most reliable browser-based audio capture."

70. MICROPHONE-ONLY FALLBACK

If meeting audio cannot be captured:

allow:

Microphone Only Mode

In this mode use STT diarization/question classification where possible.

Clearly state accuracy may be reduced because both sides may reach the same microphone.

Still allow manual:

Generate Answer From Last Transcript

71. DEMO MODE

If APIs are not configured:

allow a DEMO MODE.

Clearly label:

DEMO

Never display demo transcription as if it were live.

Once real credentials exist:

use live APIs.

72. REQUIRED SECRETS

When appropriate ask me to securely configure:

OPENAI_API_KEY

DEEPGRAM_API_KEY

STRIPE_SECRET_KEY

STRIPE_WEBHOOK_SECRET

Do not ask me to paste those secrets into React components.

73. DEVELOPMENT ORDER

Follow this exact order.

PHASE 1 — FOUNDATION

Supabase connection

Auth

Profiles

Database tables

RLS

Dashboard skeleton

Resume upload

PHASE 2 — RESUME INTELLIGENCE

Document processing

Text extraction

Chunking

Primary resume

Context retrieval

Test question → resume retrieval

PHASE 3 — MICROPHONE

Microphone permission

Device selection

Audio meter

Streaming transcription

Partial/final transcript

Session persistence

Get microphone-only flow fully working.

PHASE 4 — GOOGLE MEET / ZOOM WEB AUDIO

getDisplayMedia

meeting tab selection

remote audio track verification

remote meter

remote STT

dual transcript

separate interviewer/candidate sources

Get Google Meet working before continuing.

PHASE 5 — QUESTION DETECTION

Question classifier

confidence

deduplication

interviewer-only automatic triggering

question history

PHASE 6 — AI ANSWERS

Resume-aware context

OpenAI server integration

streaming answer

answer controls

cancellation

follow-up context

PHASE 7 — END-TO-END RELIABILITY

30+ minute sessions

reconnect

pause/resume

network recovery

cleanup

session notes

history

PHASE 8 — PRACTICE + CODING

Practice interviewer

feedback

coding page

PHASE 9 — BILLING

Stripe

credits

plans

webhooks

PHASE 10 — POLISH

Admin

mobile

accessibility

analytics

performance

74. CRITICAL DEVELOPMENT RULE

At the end of EACH phase:

Run/test the actual current workflow.

Fix errors before proceeding.

Do not replace working functionality with mock data.

Do not redesign stable components unless necessary.

75. DEBUG PANEL

Create developer-only debug panel.

Show:

Browser
Audio permissions
Microphone device
Microphone track state
Meeting track state
Meeting audio level
Mic audio level
Remote STT state
Local STT state
Remote transcript count
Local transcript count
Last question confidence
Current question
AI request state
First token latency
Errors

This will be extremely useful during Google Meet/Zoom debugging.

Production users should not see it unless Debug Mode enabled.

76. LOGGING

Create useful logs without storing secret credentials.

Log:

session started
audio connected
audio disconnected
STT connected
STT error
question detected
answer generation started
answer complete
answer aborted
session ended

Never log full API keys.

Avoid logging full private resumes unnecessarily.

77. FRONTEND COMPONENT ARCHITECTURE

Use modular components.

Examples:

SessionSetupWizard

AudioSourceSetup

MicrophoneSelector

AudioLevelMeter

ConnectionStatus

LiveTranscript

TranscriptSegment

CurrentQuestion

StreamingAnswer

AnswerControls

QuestionHistory

SessionTopBar

SessionDebugPanel

ResumeUploader

DocumentCard

PracticeSession

Do not create one 3,000-line Session component.

78. SERVICE ARCHITECTURE

Separate services/hooks:

useMicrophoneAudio()

useMeetingAudio()

useRemoteTranscription()

useLocalTranscription()

useInterviewSession()

useQuestionDetection()

useStreamingAnswer()

useSessionPersistence()

useAudioDevices()

Keep responsibilities clearly separated.

79. MEDIA CLEANUP

Every MediaStreamTrack must be stopped when no longer required:

track.stop()

Close:

AudioContexts
WebSockets
MediaRecorders

Remove:

event listeners
intervals
timeouts

Cleanup must run:

on session end
on component unmount
on source reconnect

80. DO NOT DO THESE THINGS

Do not:

fake transcription

fake Google Meet connection

fake Zoom connection

show Connected without an audio track

hardcode API secrets

disable RLS

store private resumes publicly

answer candidate speech as if interviewer asked it

generate on every transcript sentence

create duplicate questions from partial STT

create duplicate WebSockets

leave microphone active after session ends

invent resume achievements

claim unsupported Zoom Desktop capture works

build stealth/proctoring-evasion features

copy Parakeet branding

use placeholder buttons with no functionality

81. PRODUCT DEFINITION OF DONE

MVP is DONE only when:

User can signup

User can upload resume

Resume processes successfully

User can start session

Microphone works

Google Meet tab audio works on supported Chrome setup

Zoom Web tab audio works on supported Chrome setup

Remote and local transcript are separated

Questions auto-detect

Candidate speech does not trigger interviewer question flow

AI retrieves resume context

Answer streams automatically

Multiple consecutive questions work

Follow-up context works

Session can be ended

Media stops

Session saves

Notes generate

History works

RLS is secure

No demo data appears in real mode

82. YOUR FIRST ACTION NOW

Start implementation.

Do NOT simply explain what you would build.

Actually create the app.

Begin with:

Supabase/backend setup.

Authentication.

Database schema and RLS.

Core dashboard.

Resume upload/processing.

Session route.

Microphone capture.

After those are functional, immediately move to:

Google Meet / Zoom Web meeting audio capture using explicit browser permissions.

Prioritize the complete working pipeline:

AUDIO → TRANSCRIPT → QUESTION → CONTEXT → STREAMED AI ANSWER.

Whenever you encounter a browser limitation, implement honest capability detection and fallback behavior instead of replacing it with fake functionality.

Keep all existing working functionality intact as the application evolves.

The final result should feel like a polished production SaaS application, but real-time meeting functionality, low latency, reliability, privacy and security are more important than decorative design.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://talk-aide-flow.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/7a0711b7-c5df-47c7-935f-b6b1e2b5f2d0).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
