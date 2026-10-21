// Keep the existing multivendor navigation contracts for retained account flows.
export const getModeHomeRoute = (_mode) => ({
  name: 'Main',
  params: { screen: 'Discovery' }
})
export const getModeProfileRoute = (_mode, params) => ({
  name: 'Profile',
  params
})
export const getModeProfileTabRoute = (_mode) => ({
  name: 'Main',
  params: { screen: 'Profile' }
})
