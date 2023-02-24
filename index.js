import * as fs from 'node:fs/promises'
import { Command, InvalidArgumentError } from 'commander'
import { Downloader } from './src/downloader.js'

const pkg = JSON.parse(
  await fs.readFile(
    new URL('./package.json', import.meta.url)
  )
)

const program = new Command()

program
  .name(pkg.name)
  .description(pkg.description)
  .version(pkg.version)

program
  .argument('<url>', 'URL of the website to scrape')
  .option('-o, --outDir <path>', 'output directory used to save files', 'pages')
  .option('-t, --timeout <delay>', 'request timeout in seconds', value => {
    const parsedValue = parseInt(value, 10)
    if (isNaN(parsedValue)) {
      throw new InvalidArgumentError('Not a number.')
    }
    if (parsedValue < 0) {
      throw new InvalidArgumentError('Must be zero or positive number.')
    }
    return parsedValue
  }, 30)
  .action(async (url, options) => {
    const downloader = new Downloader(options)
    await downloader.run(url)
  })

program.parse()
