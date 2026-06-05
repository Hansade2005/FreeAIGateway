import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Menu, Moon, Sun, Boxes, Terminal, KeyRound, Activity, SlidersHorizontal } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate } from '@/components/auth-gate'
import { BrandLink } from '@/components/brand'
import { apiFetch, logout } from '@/lib/api'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import SettingsPage from '@/pages/SettingsPage'

const queryClient = new QueryClient()

const navItems = [
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/playground', label: 'Playground', icon: Terminal },
  { to: '/keys', label: 'Keys', icon: KeyRound },
  { to: '/analytics', label: 'Analytics', icon: Activity },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
]

function getPreferredDarkMode() {
  if (typeof window === 'undefined') return true
  // Dark-first by brand: only an explicit 'light' choice opts out.
  return localStorage.getItem('theme') !== 'light'
}

function isActivePath(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(to + '/')
}

function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Boxes }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `group relative flex items-center gap-2 px-1 py-4 text-sm transition-colors ${
          isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={`size-4 transition-colors ${isActive ? 'text-signal' : ''}`} />
          <span>{label}</span>
          {/* signal underline on the active route */}
          <span
            className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-all ${
              isActive ? 'bg-signal opacity-100' : 'opacity-0 group-hover:opacity-40 group-hover:bg-foreground'
            }`}
          />
        </>
      )}
    </NavLink>
  )
}

function useTheme() {
  const [dark, setDark] = useState(getPreferredDarkMode)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.classList.toggle('light', !dark)
  }, [dark])

  function toggle() {
    setDark((current) => {
      const next = !current
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }

  return { dark, toggle }
}

function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}

// Live gateway heartbeat — pings the unauthenticated /api/ping every 20s.
function StatusPill() {
  const { isSuccess, isError } = useQuery({
    queryKey: ['ping'],
    queryFn: () => apiFetch<{ status: string }>('/api/ping'),
    refetchInterval: 20000,
    retry: false,
  })
  const online = isSuccess && !isError
  return (
    <div className="hidden items-center gap-2 rounded-full border bg-surface-1/60 px-3 py-1 text-[11px] font-mono uppercase tracking-wider lg:flex">
      {online ? (
        <>
          <span className="status-dot" />
          <span className="text-muted-foreground">Gateway online</span>
        </>
      ) : (
        <>
          <span className="size-2 rounded-full bg-warn" />
          <span className="text-muted-foreground">Connecting…</span>
        </>
      )}
    </div>
  )
}

const isDesktopApp = typeof window !== 'undefined' && (window as any).__FREEAPI_DESKTOP__ === true

if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function Navbar() {
  const { dark, toggle } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur-xl ${isDesktopApp ? 'glass' : 'bg-background/70'}`}
      style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div
        className={`mx-auto flex max-w-7xl items-center px-4 sm:px-6 ${isDesktopApp ? 'pl-20 sm:pl-20' : ''}`}
        style={isDesktopApp ? { minHeight: 56 } : undefined}
      >
        <BrandLink />
        <nav
          className="ml-10 hidden items-center gap-7 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
        <div
          className="ml-auto hidden items-center gap-2 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <StatusPill />
          <ThemeToggle dark={dark} onToggle={toggle} />
          {!isDesktopApp && (
            <Button variant="ghost" size="sm" onClick={() => logout()}>
              Sign out
            </Button>
          )}
        </div>
        <div className="ml-auto md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label="Open navigation menu"
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                {navItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActivePath(location.pathname, item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="justify-between">
                  <span>Theme</span>
                  {dark ? <Sun /> : <Moon />}
                </DropdownMenuItem>
                {!isDesktopApp && (
                  <DropdownMenuItem onClick={() => logout()}>Sign out</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <div className={`grain relative min-h-screen ${isDesktopApp ? 'desktop-backdrop' : 'app-canvas'}`}>
            <Navbar />
            <main className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6">
              <Routes>
                <Route path="/" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                <Route path="/models/chat" element={<FallbackPage />} />
                <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/keys" element={<KeysPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/test" element={<Navigate to="/playground" replace />} />
                <Route path="/health" element={<Navigate to="/keys" replace />} />
              </Routes>
            </main>
          </div>
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
