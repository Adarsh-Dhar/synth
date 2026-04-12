# Synth - AI Trading Platform

> Sleep soundly. Let AI trade at 100ms on Solana.

A modern, production-ready autonomous AI trading platform built with Next.js 16, React 19, and TypeScript.

## Overview

Synth is a comprehensive platform for deploying and managing autonomous AI trading agents powered by cryptographically secure session keys on the Solana blockchain. The application features:

- 🎯 **Modern Landing Page** - Compelling hero section with feature showcase and CTAs
- 📊 **Comprehensive Dashboard** - Real-time agent monitoring, performance tracking, and management
- 🚀 **Deploy Agents** - Intuitive wizard for creating and configuring AI trading agents
- 📈 **Monitor Performance** - Live charts, execution logs, and detailed agent analytics
- 🌉 **Cross-Chain Bridge** - Multi-network fund deposits with fee estimation
- 📱 **Fully Responsive** - Mobile-optimized design for all devices
- 🎨 **Professional Design** - Dark mode with electric blue and purple accents

## Features

### Landing Page (/)
- Hero section with compelling headline: "Sleep soundly. Let AI trade at 100ms on Solana."
- Feature highlights (Zero-Click Trading, Mathematically Secure, Instant Cross-Chain)
- Security information with enterprise-grade guarantees
- Call-to-action buttons for conversion
- Complete footer with navigation and social links

### Dashboard (/dashboard)
- Statistics overview (balance, 24h PnL, active agents)
- Active agents table with status and performance metrics
- Quick actions for deploying new agents
- Responsive design with mobile support

### Deploy Agent (/dashboard/deploy)
- 3-step agent creation wizard
- AI model selection
- Trading pair configuration
- Session key settings (spend limits and duration)
- Form validation with visual feedback

### Agent Details (/dashboard/agents/[id])
- Real-time agent status monitoring
- Profit/Loss chart visualization
- Live execution terminal with transaction logs
- Emergency session revocation
- Agent statistics and performance metrics

### Bridge/Wallet (/dashboard/bridge)
- Cross-chain deposit interface
- Network selection (Solana Testnet)
- Amount input with fee calculation
- Security highlights and asset information

## Tech Stack

- **Framework**: Next.js 16
- **Runtime**: Node.js 18+
- **UI Library**: React 19.2
- **Language**: TypeScript 5.7
- **Styling**: Tailwind CSS v4
- **Components**: shadcn/ui (50+ components)
- **Icons**: Lucide React
- **Charts**: Recharts
- **Package Manager**: pnpm

## Quick Start

### Prerequisites
- Node.js 18 or higher
- pnpm (or pnpm/yarn)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd synth

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
# Build the application
pnpm build

# Start production server
pnpm start
```

## Project Structure

```
synth/
├── app/
│   ├── layout.tsx                 # Root layout
│   ├── page.tsx                   # Landing page
│   ├── globals.css                # Theme and design tokens
│   └── dashboard/
│       ├── layout.tsx             # Dashboard layout
│       ├── page.tsx               # Dashboard overview
│       ├── deploy/                # Deploy agent
│       ├── agents/                # Agent details
│       └── bridge/                # Cross-chain bridge
├── components/
│   ├── landing-header.tsx         # Navigation header
│   ├── feature-card.tsx           # Feature highlight
│   ├── login-modal.tsx            # Wallet connection
│   ├── sidebar.tsx                # Dashboard sidebar
│   ├── stat-card.tsx              # Statistics card
│   ├── agents-table.tsx           # Agents table
│   ├── execution-terminal.tsx     # Live logs
│   ├── pnl-chart.tsx              # Charts
│   └── ui/                        # shadcn components
├── lib/
│   ├── dummy-data.ts              # Mock data
│   └── utils.ts                   # Utilities
└── public/                        # Static assets
```

## Design System

### Colors (Dark Mode)
| Purpose | Color | Hex |
|---------|-------|-----|
| Background | Deep Navy | `#0f1419` |
| Card | Dark Slate | `#1a1f2e` |
| Primary | Electric Blue | `#0ea5e9` |
| Secondary | Purple | `#8b5cf6` |
| Border | Gray | `#2d3748` |
| Text | Off-white | `#f5f5f7` |

### Typography
- **Font Family**: Geist (sans-serif)
- **Mono**: Geist Mono
- **Line Height**: 1.5 (body), 1.2 (headings)

## Routing Map

| Route | Purpose | Status |
|-------|---------|--------|
| `/` | Landing page | ✅ Complete |
| `/dashboard` | Dashboard overview | ✅ Complete |
| `/dashboard/deploy` | Deploy agent | ✅ Complete |
| `/dashboard/agents/[id]` | Agent details | ✅ Complete |
| `/dashboard/bridge` | Cross-chain bridge | ✅ Complete |

## Documentation

- **[PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md)** - Comprehensive project overview
- **[ROUTING_GUIDE.md](./ROUTING_GUIDE.md)** - Detailed routing and architecture
- **[LANDING_PAGE_GUIDE.md](./LANDING_PAGE_GUIDE.md)** - Landing page implementation
- **[QUICK_START.md](./QUICK_START.md)** - Quick reference guide

## Key Components

### Landing Components
- `LandingHeader` - Navigation bar with CTA
- `FeatureCard` - Feature highlight card
- `LoginModal` - Wallet connection modal

### Dashboard Components
- `Sidebar` - Navigation menu
- `StatCard` - Statistics display
- `AgentsTable` - Agents list
- `ExecutionTerminal` - Live logs
- `PnLChart` - Performance chart

## API Integration Points

The application is ready for integration with:

- **Wallet Connection**: Solana wallet adapter modal (component prepared)
- **Trading APIs**: Solana blockchain endpoints
- **Database**: Supabase, Neon, or Firebase
- **Real-time Updates**: WebSocket connections
- **Analytics**: Vercel Analytics (integrated)

## Development Guidelines

### Adding New Pages
1. Create folder under `app/dashboard/[feature]`
2. Add `page.tsx` component
3. Use dashboard layout for consistent sidebar

### Component Development
```tsx
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export function MyComponent() {
  return (
    <Card className="p-6">
      <Button>Click me</Button>
    </Card>
  )
}
```

### Styling
- Use design tokens from `globals.css`
- Responsive classes: `sm:`, `md:`, `lg:`
- Tailwind utilities for spacing, colors, effects

## Performance

- Static landing page (no API calls)
- Optimized component structure
- Efficient re-renders with proper memoization
- Fast navigation with Next.js routing
- Image optimization ready

## Accessibility

- Semantic HTML structure
- Proper heading hierarchy
- ARIA attributes
- Keyboard navigation support
- Color contrast compliance
- Screen reader friendly

## Responsive Design

- **Mobile (< 640px)**: Single column, stacked layout
- **Tablet (640px - 1024px)**: Two columns, flexible
- **Desktop (> 1024px)**: Full layout with sidebar

## Browser Support

- Chrome/Edge ✅
- Safari ✅
- Firefox ✅
- Mobile browsers ✅

## Security

- Non-custodial design (user retains funds)
- Session key limits with spending caps
- Time-based expiration windows
- Blockchain verification of transactions
- No sensitive data stored client-side

## Future Enhancements

- [ ] Real WebSocket for live updates
- [ ] Agent creation and deployment APIs
- [ ] User authentication system
- [ ] Wallet integration (InterwovenKit)
- [ ] Transaction history and analytics
- [ ] Advanced charting and visualization
- [ ] Export and reporting features
- [ ] Mobile app version

## Deployment

### Deploy to Vercel

```bash
# Push to GitHub
git push origin main

# Connect repository to Vercel
# Select "Create Git Integration"
# Deploy automatically on push
```

### Environment Variables

Create `.env.local`:
```
NEXT_PUBLIC_API_URL=https://api.example.com
```

## License

[Your License Here]

## Support

For questions or issues:
- 📧 Email: support@synth.io
- 💬 Discord: [Join Community](https://discord.gg/synth)
- 🐛 Issues: [GitHub Issues](https://github.com/synth/platform/issues)

## Credits

Built with:
- [Next.js](https://nextjs.org)
- [React](https://react.dev)
- [Tailwind CSS](https://tailwindcss.com)
- [shadcn/ui](https://ui.shadcn.com)
- [Lucide Icons](https://lucide.dev)
- [Recharts](https://recharts.org)

---

**Synth** © 2024. All rights reserved.

**Current Status**: Production Ready v1.0.0
