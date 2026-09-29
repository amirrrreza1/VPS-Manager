import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { countUsers } from "@/lib/auth";
import Shell from "./shell";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  if (countUsers() === 0) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return <Shell username={user.username}>{children}</Shell>;
}
