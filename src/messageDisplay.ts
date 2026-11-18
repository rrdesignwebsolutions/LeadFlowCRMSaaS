export function displayMessage(body: string | null, type: string | null) {
  return type === "unsupported" && body === "[Mensagem não suportada]"
    ? "[Mensagem não disponibilizada pela Meta. Confira no WhatsApp Business.]"
    : body
}
