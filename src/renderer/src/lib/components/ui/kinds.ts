import type { IconName } from './icons'

export type MessageKind = 'info' | 'success' | 'warning' | 'error'
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'attention'
export type Tone = 'accent' | 'success' | 'attention' | 'danger'

export interface KindStyle {
  tone: Tone
  icon: IconName
  /** Icon and accent text color. */
  text: string
  /** Outline color. */
  border: string
  /** Tinted background. */
  bg: string
}

/** Single source of color meaning for messages (Toast, Banner, fields). Class names are literal for Tailwind. */
export const messageKinds: Record<MessageKind, KindStyle> = {
  info: {
    tone: 'accent',
    icon: 'info',
    text: 'text-accent',
    border: 'border-accent/45',
    bg: 'bg-accent/10'
  },
  success: {
    tone: 'success',
    icon: 'success',
    text: 'text-success',
    border: 'border-success/45',
    bg: 'bg-success/10'
  },
  warning: {
    tone: 'attention',
    icon: 'warning',
    text: 'text-attention',
    border: 'border-attention/55',
    bg: 'bg-attention/10'
  },
  error: {
    tone: 'danger',
    icon: 'error',
    text: 'text-danger',
    border: 'border-danger/55',
    bg: 'bg-danger/10'
  }
}

export interface VariantStyle {
  tone: Tone
  /** Resting fill, text and border. */
  base: string
  hover: string
}

/** Button variants mapped to the same tones. */
export const buttonVariants: Record<ButtonVariant, VariantStyle> = {
  primary: {
    tone: 'accent',
    base: 'bg-accent text-accent-ink border-accent',
    hover: 'hover:shadow-glow-accent'
  },
  secondary: {
    tone: 'accent',
    base: 'bg-transparent text-text border-border-strong',
    hover: 'hover:bg-surface-hover'
  },
  danger: {
    tone: 'danger',
    base: 'bg-danger text-danger-ink border-danger',
    hover: 'hover:shadow-glow-danger'
  },
  attention: {
    tone: 'attention',
    base: 'bg-attention text-attention-ink border-attention',
    hover: 'hover:shadow-glow-attention'
  }
}
