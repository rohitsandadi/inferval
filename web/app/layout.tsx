import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { InfervalQueryProvider } from "@/components/query-provider";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "inferval",
  description: "Evals and verification for agent-written inference code",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <InfervalQueryProvider>
          {children}
          <Toaster />
        </InfervalQueryProvider>
      </body>
    </html>
  );
}
