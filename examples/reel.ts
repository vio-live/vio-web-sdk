/**
 * Dev demo of `<vio-reel>` (npm run dev → http://127.0.0.1:5173/reel.html).
 *
 *   ?apiKey=<surface key>&experience=<id>[&campaign=<id>][&env=testing|production]
 *
 * The surface key is the PUBLIC one (`X-Api-Key`), never the management key.
 */
import { Vio } from '../src/index'
import '../src/ui/index'

const q = new URLSearchParams(location.search)
const apiKey = q.get('apiKey') ?? (import.meta.env.VITE_VIO_API_KEY as string | undefined) ?? ''
const experienceId = Number(q.get('experience') ?? 1)
const campaign = q.get('campaign')
const environment = (q.get('env') as 'testing' | 'production' | null) ?? 'testing'

if (!apiKey) {
  document.querySelector('.hint')!.textContent = 'Falta ?apiKey=<key pública de la surface>'
} else {
  if (campaign) document.body.setAttribute('data-vio-campaign', campaign)
  Vio.init({ apiKey, environment, debug: true })
  Vio.analytics.start({ debug: true })
  const reel = document.getElementById('reel') as HTMLElement & { experienceId: number }
  reel.experienceId = experienceId
  document.addEventListener('vio:product-click', (e) => console.log('vio:product-click', (e as CustomEvent).detail))
}
