"use client"

import { useState, useEffect, useCallback } from "react"
import { MinesGrid } from "@/components/mines-grid"
import { GameControls } from "@/components/game-controls"
import { AppHeader } from "@/components/app-header"
import { ProfileModalNeumorphic } from "@/components/profile-modal-neumorphic"
import { DepositModalSimple } from "@/components/deposit-modal-simple"
import { BottomNavigation } from "@/components/bottom-navigation"
import { CrashGame } from "@/components/crash-game"
import { CasesSection } from "@/components/cases-section"
import { BanModal } from "@/components/ban-modal"
import { Toaster } from "@/components/ui/toaster"
import { useToast } from "@/hooks/use-toast"
import { apiService, User, Transaction as ApiTransaction } from "@/lib/api"

interface Transaction {
  id: number
  type: "deposit" | "withdrawal" | "game_win" | "game_loss"
  amount: number
  currency: string
  status: "pending" | "completed" | "failed" | "cancelled"
  created_at: string
  payment_method?: string
  external_id?: string
}
import { telegramWebApp } from "@/lib/telegram-webapp"
import { TelegramProvider, useTelegram } from "@/lib/telegram-context"
import { GiftsProvider, useGifts } from "@/lib/gifts-context"
import { CrashGameProvider, useCrashGame } from "@/lib/crash-game-context"
import { useDevice } from "@/hooks/use-device"
import { ClientOnly } from "@/components/client-only"
import Image from "next/image"

interface GameState {
  id?: number
  betAmount: number
  minesCount: number
  minePositions: number[]
  revealedPositions: number[]
  currentMultiplier: number
  status: "active" | "won" | "lost" | "cashed_out"
}

// Новая таблица вероятностей с RTP 90%
const PROBABILITY_TABLE: { [mines: number]: number[] } = {
  5: [75.0, 73.68, 77.0, 75.0, 34.0, 33.0, 32.0, 31.0, 29.0, 27.0, 25.0, 22.0, 19.0, 14.0, 8.0],
  6: [70.0, 68.42, 72.0, 70.0, 31.0, 30.0, 29.0, 27.0, 25.0, 23.0, 20.0, 17.0, 13.0, 7.0],
  7: [56.25, 53.33, 55.0, 51.0, 21.0, 18.0, 15.0, 11.0, 6.0],
  8: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  9: [35.71, 30.77, 13.0, 9.0, 5.0],
  10: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
}

// Таблица множителей с RTP 90%
// Функция расчета множителя согласно ТЗ Max Win
const calculateMaxWinMultiplier = (minesCount: number, revealedCells: number): number => {
  // Для 5-10 мин используем таблицу множителей
  if (minesCount >= 5 && minesCount <= 10) {
    const multipliers = MULTIPLIER_TABLE[minesCount] || []
    const index = Math.min(revealedCells - 1, multipliers.length - 1)
    return multipliers[index] || 0.0
  }

  // Для других значений возвращаем 0
  return 0.0
}

const MULTIPLIER_TABLE: { [mines: number]: number[] } = {
  5: [1.21, 1.53, 1.96, 2.53, 3.32, 4.43, 6.01, 8.33, 11.80, 17.16],
  6: [1.28, 1.70, 2.30, 3.17, 4.43, 6.33, 9.25, 13.88, 21.45, 34.32],
  7: [1.35, 1.90, 2.73, 4.01, 6.01, 9.25, 14.65, 23.98, 40.76, 72.46],
  8: [1.43, 2.14, 3.28, 5.16, 8.33, 13.88, 23.98, 43.16, 81.52, 163.03],
  9: [1.52, 2.42, 3.98, 6.74, 11.80, 21.45, 40.76, 81.52, 173.22, 395.94],
  10: [1.62, 2.77, 4.90, 8.99, 17.16, 34.32, 72.46, 163.03, 395.94, 1055.84],
}

const calculateSurvivalProbability = (N: number, m: number, k: number): number => {
  if (k === 0) return 1.0
  if (m < 5 || m > 24) return 0.0 // Enforce mine limits
  if (k > 5) return 0.0 // Max 5 clicks in table

  const probabilities = PROBABILITY_TABLE[m]
  if (!probabilities || k > probabilities.length) return 0.0

  return probabilities[k - 1] / 100 // Convert percentage to decimal
}

const calculateMultiplier = (N: number, m: number, k: number, houseEdge = 0.1): number => {
  if (k === 0) return 1.0
  if (m < 5 || m > 10) return 0.0 // Мин должны быть от 5 до 10
  
  // Используем новую логику Max Win для расчета множителя
  const multiplier = calculateMaxWinMultiplier(m, k)
  console.log(`calculateMultiplier: N=${N}, m=${m}, k=${k}, result=${multiplier}`)
  return multiplier
}

const calculateNextClickChance = (N: number, m: number, k: number): number => {
  if (m < 5 || m > 10) return 0 // Enforce mine limits (5-10)
  if (k >= 10) return 0 // Max 10 clicks

  const probabilities = PROBABILITY_TABLE[m]
  if (!probabilities || k >= probabilities.length) return 0

  return probabilities[k] || 0 // Return next click probability directly
}

const generateMinePositions = (minesCount: number): number[] => {
  const positions: number[] = []

  // Strategic positions that players commonly click first
  const hotSpots = [6, 7, 8, 11, 12, 13, 16, 17, 18] // Center area
  const corners = [0, 4, 20, 24] // Corners
  const edges = [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23] // Edges

  // Always place mines in hot spots first
  const availableHotSpots = [...hotSpots]
  for (let i = 0; i < Math.min(minesCount, availableHotSpots.length); i++) {
    const randomIndex = Math.floor(Math.random() * availableHotSpots.length)
    positions.push(availableHotSpots.splice(randomIndex, 1)[0])
  }

  // Fill remaining with corners and edges
  const remaining = [...corners, ...edges].filter((pos) => !positions.includes(pos))
  while (positions.length < minesCount && remaining.length > 0) {
    const randomIndex = Math.floor(Math.random() * remaining.length)
    positions.push(remaining.splice(randomIndex, 1)[0])
  }

  // Fill any remaining randomly
  while (positions.length < minesCount) {
    const pos = Math.floor(Math.random() * 25)
    if (!positions.includes(pos)) {
      positions.push(pos)
    }
  }

  return positions
}

function HomePageContent() {
  const { user: telegramUser, isInitialized } = useTelegram()
  const { refreshGifts } = useGifts()
  const { setIsDemoUser } = useCrashGame()
  const device = useDevice()
  
  const [activeTab, setActiveTab] = useState<"mines" | "crash" | "cases">("crash")
  const [profileOpen, setProfileOpen] = useState(false)
  
  // Ban states
  const [banModalOpen, setBanModalOpen] = useState(false)
  const [banInfo, setBanInfo] = useState<{ reason?: string; until?: string; unbanPrice?: number; originalBalance?: number; isDemo?: boolean }>({})
  
  const [user, setUser] = useState<User>({
    id: telegramUser?.id || 123456789,
    telegramId: telegramUser?.id || 123456789,
    username: telegramUser?.username || "player123",
    firstName: telegramUser?.first_name || "Игрок",
    balance: 0, // Начинаем с 0 баланса
    total_deposited: 0,
    total_withdrawn: 0,
    is_premium: false,
    created_at: new Date().toISOString(),
  })

  const [transactions, setTransactions] = useState<Transaction[]>([])

  const [gameState, setGameState] = useState<GameState | null>(null)
  const [loading, setLoading] = useState(false)
  const [depositModalOpen, setDepositModalOpen] = useState(false)
  const [nextClickChance, setNextClickChance] = useState<number>(0)
  const [autoCashoutMultiplier, setAutoCashoutMultiplier] = useState<number | null>(null)
  const [autoCashoutClicks, setAutoCashoutClicks] = useState<number | null>(null)
  const { toast } = useToast()

  // Проверка бана пользователя
  const checkBanStatus = useCallback(async () => {
    try {
      console.log("🔍 Проверяем статус бана пользователя...")
      const banStatus = await apiService.checkBanStatus()
      
      if (banStatus.is_banned) {
        console.log("🚫 Пользователь забанен:", banStatus)
        console.log("💰 Оригинальный баланс:", banStatus.original_balance)
        console.log("💰 Текущий баланс пользователя:", user.balance)
        setBanInfo({
          reason: banStatus.reason,
          until: banStatus.until,
          unbanPrice: banStatus.unban_price,
          originalBalance: banStatus.original_balance || user.balance,
          isDemo: banStatus.is_demo
        })
        setIsDemoUser(banStatus.is_demo || false)
        setBanModalOpen(true)
        return true
      }
      
      console.log("✅ Пользователь не забанен")
      setIsDemoUser(banStatus.is_demo || false)
      return false
    } catch (error) {
      console.error("❌ Ошибка проверки бана:", error)
      return false
    }
  }, [])

  // Синхронизация баланса с базой данных
  const syncBalanceWithDatabase = useCallback(async () => {
    try {
      console.log("🔄 Синхронизация баланса с базой данных...")
      const userProfile = await apiService.getUserProfile()
      setUser(prev => ({
        ...prev,
        ...userProfile,
        balance: userProfile.balance || prev.balance
      }))
      console.log("✅ Баланс синхронизирован с базой данных")
    } catch (error) {
      console.error("❌ Ошибка синхронизации баланса:", error)
    }
  }, [])

  // Обновляем данные пользователя при изменении Telegram данных
  useEffect(() => {
    if (telegramUser) {
      setUser(prev => ({
        ...prev,
        telegramId: telegramUser.id,
        username: telegramUser.username || "player123",
        firstName: telegramUser.first_name || "Игрок",
        first_name: telegramUser.first_name || "Игрок",
      }))
      
      // Синхронизируем баланс с базой данных
      syncBalanceWithDatabase()
    }
  }, [telegramUser, syncBalanceWithDatabase])

  // Загружаем данные пользователя при инициализации
  useEffect(() => {
    if (isInitialized) {
      const initializeUser = async () => {
        // Сначала проверяем бан
        const isBanned = await checkBanStatus()
        
        // Если пользователь не забанен, загружаем остальные данные
        if (!isBanned) {
          await syncBalanceWithDatabase()
        }
      }
      
      initializeUser()
    }
  }, [isInitialized, checkBanStatus, syncBalanceWithDatabase])


  // Функция для загрузки данных пользователя
  const loadUserData = async () => {
    try {
      // Пытаемся загрузить данные пользователя из API
      const userProfile = await apiService.getUserProfile()
      setUser(prev => ({
        ...prev,
        ...userProfile,
        balance: userProfile.balance || 0
      }))
      
      // Загружаем транзакции
      const transactionsData = await apiService.getTransactions()
      // Преобразуем типы транзакций для совместимости
      const localTransactions: Transaction[] = (transactionsData.transactions || []).map(t => ({
        id: t.id,
        type: t.type === "withdraw" ? "withdrawal" : t.type as any,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        created_at: t.created_at,
        payment_method: t.payment_method,
        external_id: t.external_id
      }))
      setTransactions(localTransactions)
    } catch (error) {
      console.error('Error loading user data:', error)
      
      // Fallback на localStorage
      const savedUser = localStorage.getItem("mines-user")
      const savedTransactions = localStorage.getItem("mines-transactions")

      if (savedUser) {
        const parsedUser = JSON.parse(savedUser)
        setUser(parsedUser)
      }

      if (savedTransactions) {
        setTransactions(JSON.parse(savedTransactions))
      }
    }
  }

  useEffect(() => {
    loadUserData()
  }, [])

  // Синхронизация баланса при загрузке страницы
  useEffect(() => {
    syncBalanceWithDatabase()
  }, [])

  // Синхронизация баланса при смене вкладки (кроме Crash)
  useEffect(() => {
    if (activeTab !== "crash") {
      syncBalanceWithDatabase()
    }
  }, [activeTab])

  useEffect(() => {
    localStorage.setItem("mines-user", JSON.stringify(user))
  }, [user])

  // Автоматическое обновление баланса каждые 5 секунд
  useEffect(() => {
    const interval = setInterval(async () => {
      // Пропускаем обновление если мы в кейсах или crash
      if (activeTab === "cases" || activeTab === "crash") {
        return
      }
      
      try {
        const userProfile = await apiService.getUserProfile()
        setUser(prev => {
          const newBalance = userProfile.balance || 0
          const oldBalance = prev.balance || 0
          
          // Если баланс увеличился, показываем уведомление
          if (newBalance > oldBalance) {
            const difference = newBalance - oldBalance
            console.log('🔔 Показываем уведомление о пополнении:', {
              oldBalance,
              newBalance,
              difference,
              activeTab
            })
            const t = toast({
              title: "💰 Баланс пополнен!",
              description: `Зачислено ${difference.toFixed(2)} TON. Новый баланс: ${newBalance.toFixed(2)} TON`,
            })
            setTimeout(() => t.dismiss(), 2000)
          }
          
          return {
            ...prev,
            ...userProfile,
            balance: newBalance
          }
        })
        
        // Обновляем транзакции
        const transactionsData = await apiService.getTransactions()
        const localTransactions: Transaction[] = (transactionsData.transactions || []).map(t => ({
          id: t.id,
          type: t.type === "withdraw" ? "withdrawal" : t.type as any,
          amount: t.amount,
          currency: t.currency,
          status: t.status,
          created_at: t.created_at,
          payment_method: t.payment_method,
          external_id: t.external_id
        }))
        setTransactions(localTransactions)
      } catch (error) {
        console.error('Error updating user data:', error)
      }
    }, 5000) // Проверяем каждые 5 секунд

    return () => clearInterval(interval)
  }, [toast, activeTab])

  useEffect(() => {
    localStorage.setItem("mines-transactions", JSON.stringify(transactions))
  }, [transactions])

  const showToast = (title: string, description: string, variant: "default" | "destructive" = "default") => {
    const t = toast({
      title,
      description,
      variant,
    })
    setTimeout(() => t.dismiss(), 2000)
  }

  const handleStartGame = async (betAmount: number, minesCount: number) => {
    if (minesCount < 5 || minesCount > 10) {
      showToast("Некорректное количество мин", "Количество мин должно быть от 5 до 10", "destructive")
      return
    }

    if (betAmount > user.balance) {
      showToast("Недостаточно средств", "Пополните баланс для продолжения игры", "destructive")
      return
    }

    setLoading(true)

    let riskWarning = ""
    if (minesCount <= 3) {
      riskWarning = "Низкий риск - высокие шансы на первые клики"
    } else if (minesCount <= 7) {
      riskWarning = "Средний риск - умеренные множители"
    } else if (minesCount <= 15) {
      riskWarning = "Высокий риск - большие множители, но опасно"
    } else {
      riskWarning = "Экстремальный риск - огромные множители, почти гарантированный проигрыш"
    }

    // Уведомление о начале игры отключено

    // Генерируем позиции мин
    let minePositions: number[]
    
    if (betAmount > 5) {
      // Если ставка больше 5 TON, то автоматический подрыв на первой мине
      minePositions = generateMinePositions(minesCount)
      // Если первая позиция не мина, заменяем её на мину
      if (!minePositions.includes(0)) {
        // Находим первую позицию, которая является миной, и заменяем её на 0
        const firstMineIndex = minePositions.findIndex(pos => pos !== 0)
        if (firstMineIndex !== -1) {
          minePositions[firstMineIndex] = 0
        } else {
          // Если все позиции уже 0, просто добавляем 0 в начало
          minePositions[0] = 0
        }
      }
      console.log(`💥 АВТОПОДРЫВ: ${betAmount} TON > 5 TON, мина на позиции 0`)
    } else if (banInfo.isDemo) {
      // Для демо-пользователей: 100% шансы на выигрыш (все позиции безопасны)
      minePositions = []
      console.log(`🎮 ДЕМО-ИГРА: ${betAmount} TON <= 5 TON, 100% шансы для демо-пользователя (все позиции безопасны)`)
    } else {
      // Обычная генерация для ставок 5 TON и меньше
      minePositions = generateMinePositions(minesCount)
      console.log(`🎯 ОБЫЧНАЯ ИГРА: ${betAmount} TON <= 5 TON, стандартная генерация мин`)
    }

    const newGameState: GameState = {
      id: Date.now(),
      betAmount,
      minesCount,
      minePositions,
      revealedPositions: [],
      currentMultiplier: 1.0,
      status: "active",
    }

    console.log("handleStartGame - newGameState:", newGameState)
    console.log("handleStartGame - minePositions:", minePositions)
    
    // Мгновенно обновляем баланс локально
    setUser((prev) => ({ ...prev, balance: prev.balance - betAmount }))
    
    // Устанавливаем состояние игры
    setGameState(newGameState)
    setNextClickChance(calculateNextClickChance(25, minesCount, 0))
    setLoading(false)
    
    // Обновляем баланс в базе данных в фоне (без ожидания)
    apiService.updateBalance(betAmount, "bet" as any).then((response) => {
      if (response) {
        console.log(`💰 Баланс синхронизирован с сервером: ${response.newBalance} TON`)
        // Обновляем баланс только если он отличается от локального
        const expectedBalance = user.balance - betAmount
        if (Math.abs(response.newBalance - expectedBalance) > 0.01) {
          setUser((prev) => ({ ...prev, balance: response.newBalance }))
        }
      }
    }).catch((error) => {
      console.error("❌ Ошибка синхронизации баланса:", error)
    })
  }

  const handleCellClick = async (position: number) => {
    console.log("handleCellClick called:", { position, gameState, status: gameState?.status })
    
    if (!gameState || gameState.status !== "active") {
      console.log("handleCellClick - game not active:", { gameState: !!gameState, status: gameState?.status })
      return
    }
    if (gameState.revealedPositions.includes(position)) {
      console.log("handleCellClick - position already revealed:", position)
      return
    }

    const isMine = gameState.minePositions.includes(position)
    console.log("handleCellClick - isMine:", isMine, "minePositions:", gameState.minePositions)

    if (isMine) {
      setGameState((prev) => (prev ? { ...prev, status: "lost" } : null))
      const t = toast({ title: "Взрыв!", description: "Вы попали на мину. Попробуйте еще раз!", variant: "destructive" })
      setTimeout(() => t.dismiss(), 2000)
      setNextClickChance(0)
      
      // НЕ останавливаем автоигру при взрыве - она сама обработает это
      
      // НЕ очищаем поле автоматически - пользователь сам решает, когда начать новую игру
    } else {
      const newRevealedPositions = [...gameState.revealedPositions, position]
      // Множитель рассчитывается за все открытые клетки (включая текущую)
      const newMultiplier = calculateMultiplier(25, gameState.minesCount, newRevealedPositions.length)
      const newNextClickChance = calculateNextClickChance(25, gameState.minesCount, newRevealedPositions.length)

      const updatedGameState = {
        ...gameState,
        revealedPositions: newRevealedPositions,
        currentMultiplier: newMultiplier,
      }

      // Отладочная информация
      console.log("handleCellClick - newMultiplier:", newMultiplier)
      console.log("handleCellClick - updatedGameState:", updatedGameState)

      setGameState(updatedGameState)
      setNextClickChance(newNextClickChance)

      if (autoCashoutMultiplier && newMultiplier >= autoCashoutMultiplier) {
        handleCashOut()
        return
      }

      if (autoCashoutClicks && newRevealedPositions.length >= autoCashoutClicks) {
        handleCashOut()
        return
      }

      const potentialWinnings = updatedGameState.betAmount * updatedGameState.currentMultiplier
      // Уведомление при безопасном клике отключено
    }
  }


  const handleCashOut = async () => {
    if (!gameState || gameState.status !== "active") return

    const rawWinnings = gameState.betAmount * gameState.currentMultiplier
    const winnings = Math.floor(rawWinnings * 100) / 100
    const newBalance = user.balance + winnings

    // Мгновенно обновляем баланс локально
    setUser((prev) => ({ ...prev, balance: newBalance }))
    
    // Обновляем состояние игры
    setGameState((prev) => (prev ? { ...prev, status: "cashed_out" } : null))
    setNextClickChance(0)
    
    // НЕ останавливаем автоигру при выигрыше - она сама обработает это

    const newTransaction: Transaction = {
      id: Date.now(),
      type: "game_win",
      amount: winnings,
      currency: "TON",
      status: "completed",
      created_at: new Date().toISOString(),
    }
    setTransactions((prev) => [newTransaction, ...prev])

    // Показать уведомление и автоматически скрыть через 2 секунды
    const t = toast({ title: "Поздравляем!", description: `Вы выиграли ${winnings.toFixed(2)} TON!` })
    setTimeout(() => t.dismiss(), 2000)
    
    // Обновляем баланс в базе данных в фоне (без ожидания)
    apiService.updateBalance(winnings, "win" as any).then((response) => {
      if (response) {
        console.log(`💰 Баланс синхронизирован с сервером: ${response.newBalance} TON`)
        // Обновляем баланс только если он отличается от локального
        if (Math.abs(response.newBalance - newBalance) > 0.01) {
          setUser((prev) => ({ ...prev, balance: response.newBalance }))
        }
      }
    }).catch((error) => {
      console.error("❌ Ошибка синхронизации баланса:", error)
    })
    
    // НЕ очищаем поле автоматически - пользователь сам решает, когда начать новую игру
  }

  const handleDepositClick = () => {
    setDepositModalOpen(true)
  }

  const handleSaveWin = async (amount: number) => {
    try {
      // Обновляем баланс в базе данных через API
      const response = await apiService.updateBalance(amount, "win" as any)
      
      if (response) {
        // Обновляем локальное состояние с актуальным балансом из базы
        setUser((prev) => ({ ...prev, balance: response.newBalance }))
        
        // Подарки обновляются только вручную
      }
    } catch (error) {
      console.error("Error updating balance for win:", error)
      throw error // Пробрасываем ошибку, чтобы компонент Crash мог ее обработать
    }
  }

  const handleDeposit = async (amount: number, method: string) => {
    try {
      // Обновляем баланс в базе данных через API
      const response = await apiService.updateBalance(amount, "deposit")
      
      if (response) {
        // Обновляем локальное состояние с актуальным балансом из базы
        setUser((prev) => ({ ...prev, balance: response.newBalance }))

        const newTransaction: Transaction = {
          id: Date.now(),
          type: "deposit",
          amount: amount,
          currency: "TON",
          status: "completed",
          created_at: new Date().toISOString(),
          payment_method: method,
        }

        setTransactions((prev) => [newTransaction, ...prev])

        // Подарки обновляются только вручную

        showToast("Пополнение успешно!", `Баланс пополнен на ${amount.toFixed(2)} TON`)
      }
    } catch (error) {
      console.error("Error processing deposit:", error)
      showToast("Ошибка пополнения", "Не удалось обработать пополнение", "destructive")
    }
  }

  const handleWithdraw = async (amount: number) => {
    if (amount > user.balance) {
      showToast("Недостаточно средств", "Недостаточно средств для вывода", "destructive")
      return
    }

    try {
      // Обновляем баланс в базе данных через API
      const response = await apiService.updateBalance(amount, "withdraw")
      
      if (response) {
        // Обновляем локальное состояние с актуальным балансом из базы
        setUser((prev) => ({ ...prev, balance: response.newBalance }))

        const newTransaction: Transaction = {
          id: Date.now(),
          type: "withdrawal",
          amount: -amount,
          currency: "TON",
          status: "completed",
          created_at: new Date().toISOString(),
        }
        setTransactions((prev) => [newTransaction, ...prev])

        // Подарки обновляются только вручную

        showToast("Заявка отправлена!", `Заявка на вывод ${amount} TON отправлена`)
      }
    } catch (error) {
      console.error("Error processing withdrawal:", error)
      showToast("Ошибка вывода", "Не удалось обработать вывод средств", "destructive")
    }
  }

  const handleBalanceUpdate = (newBalance: number | ((prev: number) => number)) => {
    setUser((prev) => ({ 
      ...prev, 
      balance: typeof newBalance === 'function' ? newBalance(prev.balance) : newBalance 
    }))
  }

  const handleTabChange = (tab: "mines" | "crash" | "cases") => {
    // Если выходим из игры Crash, синхронизируем баланс с базой данных
    if (activeTab === "crash" && tab !== "crash") {
      syncBalanceWithDatabase()
    }
    
    // Закрываем профиль при смене вкладки
    if (profileOpen) {
      setProfileOpen(false)
    }

    setActiveTab(tab)
  }


  return (
    <div className="min-h-screen relative bg-background" data-device={device}>
      {/* Modern animated grid background */}
      <div className="grid-background-with-drops" />
      <div className="drops-container">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="drop-animation" />
        ))}
      </div>

      {/* Unified App Header */}
      <div className="relative z-50 tab-content">
        <AppHeader
          balance={user.balance}
          username={user.firstName || user.first_name}
          onProfileClick={() => setProfileOpen(true)}
          onDepositClick={handleDepositClick}
        />
      </div>

      {/* Main Content */}
      {activeTab === "mines" && (
        <main
          className={`tab-content mobile-content mines-container ${
            device === "desktop"
              ? "px-6 py-8 space-y-8 relative z-10 pb-20 pt-24"
              : "px-2 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-8 relative z-10 pb-20"
          }`}
        >
          <MinesGrid
            gameState={gameState || undefined}
            onCellClick={handleCellClick}
            disabled={loading}
          />

          <GameControls
            balance={user.balance}
            gameState={gameState || undefined}
            onStartGame={handleStartGame}
            onCashOut={handleCashOut}
            disabled={loading}
            nextClickChance={nextClickChance}
            autoCashoutMultiplier={autoCashoutMultiplier}
            autoCashoutClicks={autoCashoutClicks}
            onAutoCashoutMultiplierChange={setAutoCashoutMultiplier}
            onAutoCashoutClicksChange={setAutoCashoutClicks}
            
          />
        </main>
      )}

      {/* Crash Game */}
      {activeTab === "crash" && (
        <div className="tab-content mobile-content crash-game-container">
          <CrashGame
            userBalance={user.balance}
            onBalanceUpdate={handleBalanceUpdate}
            onProfileClick={() => setProfileOpen(true)}
            onDepositClick={handleDepositClick}
            username={user.firstName || user.first_name}
            onShowToast={showToast}
            onSaveWin={handleSaveWin}
          />
        </div>
      )}

      {/* Cases Tab */}
      {activeTab === "cases" && (
        <div className="min-h-screen bg-background tab-content mobile-content cases-container">
          <div className="relative z-10 pb-24 px-2 sm:px-4">
            <CasesSection
              userBalance={user.balance}
              onBalanceUpdate={handleBalanceUpdate}
            />
          </div>
        </div>
      )}

      {/* Bottom Navigation */}
      <div className="relative">
        <BottomNavigation
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
      </div>


      <div className="relative z-50">
        <DepositModalSimple
          open={depositModalOpen}
          onOpenChange={setDepositModalOpen}
          onDeposit={handleDeposit}
          currentBalance={user.balance}
        />
        <ProfileModalNeumorphic
          open={profileOpen}
          onOpenChange={setProfileOpen}
          user={{
            telegramId: user.telegramId || user.id,
            username: user.username,
            firstName: user.firstName || user.first_name,
            lastName: user.lastName || user.last_name,
            balance: user.balance,
            isDemo: banInfo.isDemo || false
          }}
          transactions={transactions}
          onDeposit={handleDeposit}
          onWithdraw={handleWithdraw}
          onBalanceUpdate={handleBalanceUpdate}
        />
      </div>

      <BanModal
        open={banModalOpen}
        reason={banInfo.reason}
        until={banInfo.until}
        balance={banInfo.originalBalance || user.balance}
        unbanPrice={banInfo.unbanPrice}
      />

      <Toaster />
    </div>
  )
}

export default function HomePage() {
  return (
                <TelegramProvider>
                  <GiftsProvider>
                    <CrashGameProvider>
                      <ClientOnly
                        fallback={
                          <div className="min-h-screen relative overflow-hidden bg-background">
                            <div className="grid-background" />
                            <div className="flex items-center justify-center min-h-screen">
                              <div className="text-foreground text-lg">Загрузка...</div>
                            </div>
                          </div>
                        }
                      >
                        <HomePageContent />
                      </ClientOnly>
                    </CrashGameProvider>
                  </GiftsProvider>
                </TelegramProvider>
  )
}
