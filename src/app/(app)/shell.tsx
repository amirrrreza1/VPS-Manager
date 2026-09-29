"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Projects" },
  { href: "/files", label: "Files" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

export default function Shell({ children, username }: { children: React.ReactNode; username: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="text-emerald-500">⬢</span>
            <span className="hidden sm:inline">VPS Manager</span>
          </Link>

          <nav className="flex flex-1 items-center gap-1">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-1.5 text-sm transition ${
                    active
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-zinc-500 sm:inline">{username}</span>
            <button
              onClick={logout}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
