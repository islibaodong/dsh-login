// Re-export the shipped browser client verbatim: the takeover changes only
// the host-side carrier (auth resolution + per-user dispatch). The browser
// speaks the same /api protocol; the session cookie rides along transparently.
export * from '@deepseek-ai/dsh-client-connection/client'
export { default } from '@deepseek-ai/dsh-client-connection/client'
