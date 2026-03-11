import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export type PageType = 'home' | 'sessions' | 'agents' | 'settings'

interface NavigationState {
  // Current active page
  currentPage: PageType
  
  // Section to scroll to after navigation
  scrollToSection: string | null
  
  // Sidebar state
  isSidebarCollapsed: boolean
  
  // Actions
  setCurrentPage: (page: PageType) => void
  setPage: (page: PageType, section?: string) => void  // Alias with optional section
  clearScrollSection: () => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
}

export const useNavigationStore = create<NavigationState>()(
  devtools(
    persist(
      (set) => ({
        currentPage: 'sessions',
        scrollToSection: null,
        isSidebarCollapsed: false,

        setCurrentPage: (page) => set({ currentPage: page }, false, 'setCurrentPage'),
        setPage: (page, section) => set({ currentPage: page, scrollToSection: section || null }, false, 'setPage'),
        clearScrollSection: () => set({ scrollToSection: null }, false, 'clearScrollSection'),
        
        toggleSidebar: () => set(
          (state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed }), 
          false, 
          'toggleSidebar'
        ),
        
        setSidebarCollapsed: (collapsed) => set(
          { isSidebarCollapsed: collapsed }, 
          false, 
          'setSidebarCollapsed'
        ),
      }),
      {
        name: 'navigation-store',
      }
    ),
    { name: 'navigation-store' }
  )
)
