// Общие константы для Worker и для скриптов установки.

export const MEMORY_STORE_NAME = "assistant"; // в сессии: /mnt/memory/assistant/

export const MEMORY_INSTRUCTIONS =
  "Долговременная память ассистента. В начале работы прочитай profile.md и нужные файлы из settings/. " +
  "Сохраняй сюда то, что пригодится в будущих разговорах. Никогда не записывай пароли, ключи и токены.";

export function memoryResourceFor(memoryStoreId: string) {
  return {
    type: "memory_store" as const,
    memory_store_id: memoryStoreId,
    access: "read_write" as const,
    instructions: MEMORY_INSTRUCTIONS,
  };
}

export const FAMILY_MEMORY_STORE_NAME = "personal"; // в сессии: /mnt/memory/personal/

export function familyProfile(name: string) {
  return `# Профиль\n\n- Имя: ${name}\n- Язык общения: русский. Часовой пояс: Москва (Europe/Moscow).\n\n## Предпочтения\n(дополняй по ходу разговоров)\n`;
}

export function familyMemoryResource(memoryStoreId: string) {
  return {
    type: "memory_store" as const,
    memory_store_id: memoryStoreId,
    access: "read_write" as const,
    instructions:
      "Личная память помощника этого человека. В начале разговора прочитай profile.md. " +
      "Сохраняй то, что пригодится в будущих разговорах. Никогда не записывай пароли, ключи и токены.",
  };
}
