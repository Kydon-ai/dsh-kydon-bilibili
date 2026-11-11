import { fileURLToPath } from 'node:url'
import { clientBundle } from '../packages/client/tsdown.client.ts'

export default clientBundle('@kydon/dsh-kydon-bilibili',
   ['lib/types/index.js'], {
  manifestPath: fileURLToPath(new URL('./package.json', import.meta.url)),
})
