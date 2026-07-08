import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentStore } from '@/stores/agentStore'

describe('useAgentStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAgentStore.setState({
      authState: 'idle',
      deviceCode: null,
      accessToken: null,
      tokenExpiresAt: null,
      conversationId: null,
      messages: [],
      isProcessing: false,
      questions: [],
      responseCount: 0,
      session: {
        isActive: false,
        speaker: null,
        startedAt: null,
        inFollowUpWindow: false,
      },
    })
  })

  describe('auth state', () => {
    it('should start with idle auth state', () => {
      const { result } = renderHook(() => useAgentStore())
      expect(result.current.authState).toBe('idle')
    })

    it('should update auth state', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.setAuthState('authenticating')
      })
      
      expect(result.current.authState).toBe('authenticating')
    })

    it('should set access token and update auth state', () => {
      const { result } = renderHook(() => useAgentStore())
      const expiresAt = new Date(Date.now() + 3600000)
      
      act(() => {
        result.current.setAccessToken('test-token', expiresAt)
      })
      
      expect(result.current.accessToken).toBe('test-token')
      expect(result.current.authState).toBe('authenticated')
    })
  })

  describe('conversation state', () => {
    it('should add messages', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.addMessage({
          role: 'user',
          text: 'Hello agent',
          timestamp: new Date(),
        })
      })
      
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].text).toBe('Hello agent')
      expect(result.current.messages[0].role).toBe('user')
    })

    it('should clear messages', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.addMessage({
          role: 'user',
          text: 'Hello',
          timestamp: new Date(),
        })
        result.current.addMessage({
          role: 'agent',
          text: 'Hi there!',
          timestamp: new Date(),
        })
      })
      
      expect(result.current.messages).toHaveLength(2)
      
      act(() => {
        result.current.clearMessages()
      })
      
      expect(result.current.messages).toHaveLength(0)
    })

    it('should set conversation id', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.setConversationId('conv-123')
      })
      
      expect(result.current.conversationId).toBe('conv-123')
    })
  })

  describe('session state', () => {
    it('should start and end session', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.startSession('John Doe')
      })
      
      expect(result.current.session.isActive).toBe(true)
      expect(result.current.session.speaker).toBe('John Doe')
      
      act(() => {
        result.current.endSession()
      })
      
      expect(result.current.session.isActive).toBe(false)
      expect(result.current.session.speaker).toBeNull()
    })
  })

  describe('questions tracking', () => {
    it('should add questions', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.addQuestion('Speaker 1', 'What is the weather?')
      })
      
      expect(result.current.questions).toHaveLength(1)
      expect(result.current.questions[0].speaker).toBe('Speaker 1')
      expect(result.current.questions[0].text).toBe('What is the weather?')
    })

    it('should update question response time', () => {
      const { result } = renderHook(() => useAgentStore())
      
      act(() => {
        result.current.addQuestion('Speaker 1', 'Test question')
      })
      
      const questionId = result.current.questions[0].id
      
      act(() => {
        result.current.updateQuestionResponseTime(questionId, 2500)
      })
      
      expect(result.current.questions[0].responseTime).toBe(2500)
    })
  })

  describe('response count', () => {
    it('should increment response count', () => {
      const { result } = renderHook(() => useAgentStore())
      
      expect(result.current.responseCount).toBe(0)
      
      act(() => {
        result.current.incrementResponseCount()
        result.current.incrementResponseCount()
      })
      
      expect(result.current.responseCount).toBe(2)
    })
  })
})
