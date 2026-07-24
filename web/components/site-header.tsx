import Link from 'next/link'

const NAV = [
  ['ALBUMS', '/albums'],
  ['REVIEWS', '/reviews'],
  ['ARTISTS', '/artists'],
  ['FEATURES', '/features'],
]

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/">SOUNDIVE</Link>
      <nav className="desktop-nav" aria-label="Main navigation">
        {NAV.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
      </nav>
      <Link className="profile-link" href="/profile">PROFILE</Link>
    </header>
  )
}
