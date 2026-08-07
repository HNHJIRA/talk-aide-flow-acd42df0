import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, FileText, History, Settings, LogOut, Radio, PackageOpen } from "lucide-react";
import { getIsReleaseAdmin } from "@/lib/releases.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/documents", label: "Documents", icon: FileText },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children, title }: { children: ReactNode; title?: string }) {
  const navigate = useNavigate();
  const { data: admin } = useQuery({
    queryKey: ["is-release-admin"],
    queryFn: () => getIsReleaseAdmin({ data: undefined }),
    staleTime: 5 * 60 * 1000,
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    void navigate({ to: "/auth" });
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-4 py-6 md:flex">
        <Link to="/dashboard" className="mb-8 px-2 font-sans text-base font-semibold">
          Interview<span className="text-primary">Copilot</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
          {admin?.isAdmin ? (
            <Link
              to="/admin/desktop-releases"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
            >
              <PackageOpen className="size-4" />
              Desktop releases
            </Link>
          ) : null}
        </nav>
        <Button asChild size="sm" className="mb-3">
          <Link to="/new-session">
            <Radio className="size-4" /> Start copilot
          </Link>
        </Button>
        <button
          onClick={signOut}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <LogOut className="size-4" /> Sign out
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4 md:hidden">
          <Link to="/dashboard" className="font-sans text-sm font-semibold">
            Interview<span className="text-primary">Copilot</span>
          </Link>
          <div className="flex gap-2">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className="rounded-md p-2 text-muted-foreground">
                <item.icon className="size-4" />
              </Link>
            ))}
          </div>
        </header>
        <main className="min-w-0 flex-1 px-6 py-8">
          {title ? <h1 className="mb-6 text-2xl font-semibold">{title}</h1> : null}
          {children}
        </main>
      </div>
    </div>
  );
}
