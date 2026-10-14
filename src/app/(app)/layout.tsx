import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { countUsers } from "@/lib/auth";
import Shell from "./shell";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // SQLite must be checked at request time, after the administrator is created.
  await connection();
  if (countUsers() === 0) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return <Shell username={user.username}>{children}</Shell>;
}
