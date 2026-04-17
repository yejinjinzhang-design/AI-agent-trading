import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
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
  title: "CORAL Strategy Protocol",
  description: "AI驱动的加密策略进化平台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" className={`${outfit.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="min-h-full bg-[#0A0A0F] text-white antialiased font-outfit">
        {children}
      </body>
    </html>
  );
}
