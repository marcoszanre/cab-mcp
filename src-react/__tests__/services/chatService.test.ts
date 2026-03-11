import { describe, expect, it, vi } from 'vitest'
import { MeetingChatService } from '@/services/chatService'

type MeetingChatServiceInternals = {
  callbacks: Record<string, unknown>
  chatClient: { stopRealtimeNotifications: () => Promise<void> | void } | null
  userId: string | null
}

describe('MeetingChatService disposal', () => {
  it('clears callbacks after disposal', async () => {
    const service = new MeetingChatService()
    const internal = service as unknown as MeetingChatServiceInternals
    const onDisconnected = vi.fn()

    service.setCallbacks({
      onDisconnected,
      onError: vi.fn(),
    })
    internal.chatClient = {
      stopRealtimeNotifications: vi.fn(),
    }
    internal.userId = 'test-user'

    await service.dispose()

    expect(onDisconnected).toHaveBeenCalledTimes(1)
    expect(internal.callbacks).toEqual({})
    expect(internal.chatClient).toBeNull()
    expect(internal.userId).toBeNull()
  })
})
