/**
 * apps/generator-ui/src/main.tsx
 *
 * Application entry point. AuthProvider wraps the entire app so every
 * component in the tree can call useAuth() without prop drilling.
 *
 * No Keycloak provider, no OAuth redirect setup. Authentication is handled
 * entirely by the React login form → FastAPI → Keycloak flow.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AuthProvider } from './context/AuthContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* AuthProvider initialises by calling GET /api/auth/me.
        The entire app renders inside this context — every component
        can call useAuth() to get user info and role flags. */}
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
)
