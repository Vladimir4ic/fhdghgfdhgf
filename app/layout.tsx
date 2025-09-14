import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Suspense } from "react"
import { TelegramOnlyGuard } from "@/components/telegram-only-guard"
import { TelegramInit } from "@/components/telegram-init"
import "./globals.css"

const inter = Inter({ subsets: ["latin", "cyrillic"] })

export const metadata: Metadata = {
  title: "Mines Casino - Telegram Mini App",
  description: "Играйте в Mines и выигрывайте TON",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
        <script src="/telegram-webapp.js" defer></script>
      </head>
      <body className={`${inter.className} telegram-webapp`}>
        <TelegramInit />
        <TelegramOnlyGuard>
          <Suspense
            fallback={
              <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="text-foreground">Загрузка...</div>
              </div>
            }
          >
            {children}
          </Suspense>
        </TelegramOnlyGuard>
      </body>
    </html>
  )
}
