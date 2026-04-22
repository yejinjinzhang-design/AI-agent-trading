import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Strategy Desk",
  description: "Quantitative strategy management terminal",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="min-h-full antialiased font-outfit" style={{ background: "#F5F7FB", color: "#1F2940" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
