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
