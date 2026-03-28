import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Comfortaa } from "next/font/google";

import "@/app/globals.css";
import { SiteBrand } from "@/components/site-brand";

const comfortaa = Comfortaa({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-comfortaa",
  display: "swap",
});

export const metadata: Metadata = {
  title: "treeroute",
  description:
    "A tree pollen-aware routing experience for allergy-sensitive New Yorkers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className={comfortaa.variable}>
      <body>
        {children}
        <SiteBrand />
      </body>
    </html>
  );
}
