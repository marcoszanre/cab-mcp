import { describe, expect, it, vi } from 'vitest'
import { AcsCallService } from '@/services/acsService'

type AcsCallServiceInternals = {
  cleanup: () => void
  _pendingJoinWaitReject: ((error: Error) => void) | null
}

describe('AcsCallService cleanup', () => {
  it('rejects a pending join wait only once across repeated cleanup calls', () => {
    const service = new AcsCallService()
    const internal = service as unknown as AcsCallServiceInternals
    const reject = vi.fn()

    internal._pendingJoinWaitReject = reject

    internal.cleanup()

    expect(reject).toHaveBeenCalledTimes(1)
    expect(reject.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(internal._pendingJoinWaitReject).toBeNull()

    internal.cleanup()

    expect(reject).toHaveBeenCalledTimes(1)
  })
})
