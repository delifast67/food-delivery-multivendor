import AsyncStorage from '@react-native-async-storage/async-storage'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { APP_MODES, APP_MODE_STORAGE_KEY, DEFAULT_APP_MODE } from './constants'
const AppModeContext = createContext({
  mode: DEFAULT_APP_MODE,
  isModeReady: false,
  isSwitchingMode: false,
  isModeSwitchBlocked: false,
  isModeToggleEnabled: false,
  beginModeSensitiveOperation: () => () => {},
  switchMode: async() => false
})
export const AppModeProvider = ({ children }) => {
  const [isModeReady, setIsModeReady] = useState(false)
  const [isSwitchingMode, setIsSwitchingMode] = useState(false)
  const [blockingOperationCount, setBlockingOperationCount] = useState(0)
  const blockingOperations = useRef(new Set())
  useEffect(() => {
    AsyncStorage.setItem(APP_MODE_STORAGE_KEY, DEFAULT_APP_MODE).catch(() => {})
    setIsModeReady(true)
  }, [])
  const switchMode = useCallback(async nextMode => {
    if (nextMode !== APP_MODES.MULTI || blockingOperations.current.size > 0) return false
    setIsSwitchingMode(true)
    try { await AsyncStorage.setItem(APP_MODE_STORAGE_KEY, DEFAULT_APP_MODE); return true } finally { setIsSwitchingMode(false) }
  }, [])
  const beginModeSensitiveOperation = useCallback(() => {
    const operation = Symbol('mode-sensitive-operation')
    blockingOperations.current.add(operation)
    setBlockingOperationCount(blockingOperations.current.size)
    return () => { blockingOperations.current.delete(operation); setBlockingOperationCount(blockingOperations.current.size) }
  }, [])
  const value = useMemo(() => ({
    mode: DEFAULT_APP_MODE, isModeReady, isSwitchingMode,
    isModeSwitchBlocked: blockingOperationCount > 0, isModeToggleEnabled: false,
    beginModeSensitiveOperation, switchMode
  }), [beginModeSensitiveOperation, blockingOperationCount, isModeReady, isSwitchingMode, switchMode])
  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>
}
export const useAppMode = () => useContext(AppModeContext)
export const useModeSensitiveOperation = isActive => {
  const { beginModeSensitiveOperation } = useAppMode()
  useEffect(() => { if (!isActive) return undefined; return beginModeSensitiveOperation() }, [beginModeSensitiveOperation, isActive])
}
export default AppModeContext
