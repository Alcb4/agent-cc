import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agent-cc",
  description: "Local-first agent command centre",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script below may flip
    // data-theme to the persisted value before React hydrates
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before paint so a light-mode user never
            sees a dark flash. Dark stays the SSR default per DESIGN.md. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("theme");if(t==="light")document.documentElement.dataset.theme="light";}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
