/**
 * Text as a search compares it, in the app's language with marks folded (audit action labels, final
 * review): "iki" finds "İki adımlı…" whatever the browser's language, "sifre" finds "şifre", "IKI"
 * finds it in Turkish too.
 */
export const fold = (text: string, locale: string): string =>
  text.toLocaleLowerCase(locale).normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i')
