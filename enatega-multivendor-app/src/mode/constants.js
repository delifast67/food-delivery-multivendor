export const APP_MODES = Object.freeze({ MULTI: 'MULTI' })
export const DEFAULT_APP_MODE = APP_MODES.MULTI
export const APP_MODE_STORAGE_KEY = '@enatega/app-mode'
export const VENDOR_MODE_POLICIES = Object.freeze({ MULTI: APP_MODES.MULTI })
export const getVendorModePolicy = () => VENDOR_MODE_POLICIES.MULTI
export const getForcedAppMode = () => APP_MODES.MULTI
export const isAppMode = value => value === APP_MODES.MULTI
