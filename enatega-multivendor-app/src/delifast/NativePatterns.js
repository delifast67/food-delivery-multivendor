import React from 'react'
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { resolveMultivendorTokens } from '../ui/designSystem/tokens'
import searchStyles from '../components/Main/Search/styles'

// Reuse Enatega's actual tokens and search geometry, not its legacy providers.
export const tokens = resolveMultivendorTokens('Light')
export const BRAND = { primary: tokens.colors.accent, onPrimary: tokens.colors.textOnAccent, background: tokens.colors.canvas, muted: tokens.colors.textSecondary, border: tokens.colors.borderSubtle }
export function Icon({ name, size = 22, color = tokens.colors.textPrimary }) {
  return <Ionicons name={name} size={size} color={color} accessible={false} />
}
export function SearchField({ value, onChangeText, label = 'Rechercher un restaurant', placeholder = 'Restaurants, envies…' }) {
  const s = searchStyles(tokens)
  return (
    <View style={[s.mainContainer, { backgroundColor: tokens.colors.surfaceSubtle, marginVertical: 12 }]}>
      <View style={s.subContainer}>
        <View style={s.leftContainer}>
          <Icon name='search-outline' color={tokens.colors.textMuted} size={20} />
          <TextInput accessibilityLabel={label} placeholder={placeholder} placeholderTextColor={tokens.colors.textMuted} style={[s.bodyStyleOne, { minWidth: 0 }]} value={value} onChangeText={onChangeText} returnKeyType='search' autoCorrect={false} />
        </View>
        {!!value && (
          <TouchableOpacity accessibilityRole='button' accessibilityLabel='Effacer la recherche' onPress={() => onChangeText('')} style={styles.iconButton}>
            <Icon name='close-circle-outline' size={20} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
}
export function Chip({ label, selected, onPress, variant }) {
  return (
    <TouchableOpacity accessibilityRole='button' accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && styles.chipSelected, variant === 'category' && styles.category, variant === 'category' && selected && styles.categorySelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected, variant === 'category' && selected && styles.categoryTextSelected]}>{label}</Text>
    </TouchableOpacity>
  )
}
export function EmptyState({ icon, title, description }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={40} color={tokens.colors.accentForeground} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
    </View>
  )
}
export function RestaurantMark({ name, large = false }) {
  // The current GraphQL contract has no media. Never invent a food photo or rating.
  return (
    <View style={[styles.mark, large && styles.markLarge]} accessible={false}>
      <Text style={[styles.initial, large && styles.initialLarge]}>
        {String(name || '?')
          .trim()
          .charAt(0)
          .toUpperCase()}
      </Text>
      <View style={styles.markGlyph}>
        <Icon name='restaurant-outline' size={large ? 24 : 14} color={tokens.colors.accentForeground} />
      </View>
    </View>
  )
}
export function SettingRow({ icon, title, description, onPress, disabled }) {
  return (
    <TouchableOpacity accessibilityRole='button' accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[styles.settingRow, disabled && { opacity: 0.5 }]}>
      <View style={styles.settingIcon}>
        <Icon name={icon} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingTitle}>{title}</Text>
        {!!description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      <Icon name='chevron-forward' size={18} color={tokens.colors.textMuted} />
    </TouchableOpacity>
  )
}
const styles = StyleSheet.create({
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  chip: { minHeight: 44, paddingHorizontal: 17, borderRadius: tokens.radii.round, backgroundColor: tokens.colors.surfaceSubtle, justifyContent: 'center', marginRight: 8, borderWidth: 1, borderColor: tokens.colors.borderSubtle },
  category: { minHeight: 54, borderRadius: 0, paddingHorizontal: 12, marginRight: 8, backgroundColor: 'transparent', borderWidth: 0, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  categorySelected: { backgroundColor: 'transparent', borderBottomColor: tokens.colors.accentForeground },
  categoryTextSelected: { color: tokens.colors.accentForeground },
  chipSelected: { backgroundColor: tokens.colors.accent, borderColor: tokens.colors.accent },
  chipText: { fontSize: 13, fontFamily: 'MuseoSans500', color: tokens.colors.textSecondary },
  chipTextSelected: { color: tokens.colors.textOnAccent, fontFamily: 'MuseoSans700' },
  empty: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24 },
  emptyIcon: { width: 96, height: 96, borderRadius: 48, backgroundColor: tokens.colors.accentSubtle, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  emptyTitle: { fontSize: 21, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary, textAlign: 'center' },
  emptyDescription: { fontSize: 14, lineHeight: 21, color: tokens.colors.textSecondary, textAlign: 'center', marginTop: 10 },
  mark: { width: 64, height: 64, borderRadius: tokens.radii.tile, backgroundColor: tokens.colors.accentSubtle, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  markLarge: { width: 100, height: 88, borderRadius: tokens.radii.xl },
  initial: { fontSize: 27, fontFamily: 'MuseoSans700', color: tokens.colors.accentForeground },
  initialLarge: { fontSize: 42 },
  markGlyph: { position: 'absolute', bottom: 5, right: 5 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.colors.borderSubtle, paddingVertical: 12 },
  settingIcon: { width: 42, height: 42, borderRadius: tokens.radii.tile, backgroundColor: tokens.colors.surfaceSubtle, alignItems: 'center', justifyContent: 'center' },
  settingTitle: { fontSize: 15, fontFamily: 'MuseoSans700', color: tokens.colors.textPrimary },
  settingDescription: { fontSize: 12, color: tokens.colors.textSecondary, marginTop: 4 }
})
