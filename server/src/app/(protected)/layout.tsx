import Link from "next/link";
import {redirect} from "next/navigation";

import {logoutAction} from "../actions.ts";
import {pageAuth} from "@/lib/pageAuth.ts";

export const dynamic = "force-dynamic";

/** The authenticated shell: guard + top navigation. Every page inside
 * this route group requires the session cookie. */
export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await pageAuth();
  if (!ctx) redirect("/login");
  return (
    <div>
      <nav className="nav">
        <span className="brand">lumina-server</span>
        <span className="links">
          <Link href="/">Overview</Link>
          <Link href="/sessions">Sessions</Link>
          <Link href="/users">Users</Link>
          <Link href="/account">Account</Link>
        </span>
        <span className="who">
          {ctx.user.username}
          {ctx.user.role === "admin" ? <span className="badge">admin</span> : null}
          <form action={logoutAction} style={{display: "inline"}}>
            <button type="submit" className="btn small">
              Sign out
            </button>
          </form>
        </span>
      </nav>
      <main className="wrap">{children}</main>
    </div>
  );
}
