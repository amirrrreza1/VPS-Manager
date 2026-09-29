import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VPS Manager",
  description: "Self-hosted control panel for your VPS",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">{children}</body>
    </html>
  );
}
