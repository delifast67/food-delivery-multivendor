import React, { useContext } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import UserContext from '../../context/User'
import ThemeContext from '../../ui/ThemeContext/ThemeContext'
import { theme } from '../../utils/themeColors'

const ProfileTab = ({ AuthenticatedComponent, GuestComponent, hasCartItemsOverride: _unused, ...screenProps }) => {
  const themeContext = useContext(ThemeContext)
  const currentTheme = theme[themeContext.ThemeValue]
  const { isLoggedIn } = useContext(UserContext)
  const Screen = isLoggedIn ? AuthenticatedComponent : GuestComponent
  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: currentTheme.themeBackground }]}>
      <View style={{ flex: 1 }}>
        <Screen {...screenProps} embeddedInModeProfileTab />
      </View>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({ safeArea: { flex: 1 } })
export default ProfileTab
