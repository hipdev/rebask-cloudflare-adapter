import type { ReactNode } from "react";
import { Link } from "@rebask/core/components/link";
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>Rebask Workers PPR</title>
      </head>
      <body>
        <header>
          <nav aria-label="Main navigation">
            <Link href="/">Home</Link> · <Link href="/alice">Alice</Link> ·{" "}
            <Link href="/bob">Bob</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
