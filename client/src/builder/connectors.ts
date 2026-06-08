import { Database, CreditCard, Mail, GitBranch, BarChart3, Boxes, ShieldCheck, Cloud, type LucideIcon } from 'lucide-react'

// The connector catalog. This is the ONE place to register an integration —
// adding an entry here makes it appear in every app's Settings → Integrations
// view, with its connect form and persisted state, no other wiring needed.
//
// `fields` are the credentials/config the user supplies to connect; they are
// stored locally (IndexedDB) per project. `status: 'soon'` renders the card as a
// non-connectable preview so the roadmap is visible.

export interface ConnectorField {
  key: string
  label: string
  placeholder?: string
  type?: 'text' | 'password'
}

export interface Connector {
  id: string
  name: string
  description: string
  category: 'Backend' | 'Payments' | 'Email' | 'Source' | 'Analytics' | 'AI' | 'Hosting'
  icon: LucideIcon
  fields: ConnectorField[]
  status: 'available' | 'soon'
  docsUrl?: string
}

export const CONNECTORS: Connector[] = [
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Postgres database, auth, and storage for your app.',
    category: 'Backend',
    icon: Database,
    status: 'available',
    docsUrl: 'https://supabase.com/docs',
    fields: [
      { key: 'url', label: 'Project URL', placeholder: 'https://xxxx.supabase.co' },
      { key: 'anonKey', label: 'Anon key', placeholder: 'eyJ…', type: 'password' },
    ],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Accept payments and manage subscriptions.',
    category: 'Payments',
    icon: CreditCard,
    status: 'available',
    docsUrl: 'https://stripe.com/docs',
    fields: [
      { key: 'publishableKey', label: 'Publishable key', placeholder: 'pk_live_…' },
      { key: 'secretKey', label: 'Secret key', placeholder: 'sk_live_…', type: 'password' },
    ],
  },
  {
    id: 'resend',
    name: 'Resend',
    description: 'Send transactional and marketing email.',
    category: 'Email',
    icon: Mail,
    status: 'available',
    docsUrl: 'https://resend.com/docs',
    fields: [
      { key: 'apiKey', label: 'API key', placeholder: 're_…', type: 'password' },
      { key: 'from', label: 'From address', placeholder: 'hello@yourdomain.com' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Push your app to a repository and sync changes.',
    category: 'Source',
    icon: GitBranch,
    status: 'available',
    docsUrl: 'https://docs.github.com',
    fields: [
      { key: 'token', label: 'Personal access token', placeholder: 'ghp_…', type: 'password' },
      { key: 'repo', label: 'Repository', placeholder: 'owner/repo' },
    ],
  },
  {
    id: 'openai',
    name: 'AI provider',
    description: 'Bring your own model key for AI features in the app.',
    category: 'AI',
    icon: Boxes,
    status: 'available',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.freeaigateway…' },
      { key: 'apiKey', label: 'API key', placeholder: 'sk-…', type: 'password' },
    ],
  },
  {
    id: 'analytics',
    name: 'Analytics',
    description: 'Track page views and events. Coming soon.',
    category: 'Analytics',
    icon: BarChart3,
    status: 'soon',
    fields: [],
  },
  {
    id: 'clerk',
    name: 'Clerk',
    description: 'Drop-in authentication and user management. Coming soon.',
    category: 'Backend',
    icon: ShieldCheck,
    status: 'soon',
    fields: [],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Edge hosting, KV, and R2 storage. Coming soon.',
    category: 'Hosting',
    icon: Cloud,
    status: 'soon',
    fields: [],
  },
]

export const getConnector = (id: string) => CONNECTORS.find((c) => c.id === id)
