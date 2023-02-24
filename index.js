import * as fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import * as cheerio from 'cheerio'
import slugify from '@sindresorhus/slugify'
import chalk from 'chalk'
import { Command, InvalidArgumentError } from 'commander'

const pkg = JSON.parse(
  await fs.readFile(
    new URL('./package.json', import.meta.url)
  )
)

const settings = {
  url: null,
  timeout: 30,
  outDir: 'pages',
  pdfOptions: {
    // format: 'A4',
    width: 745,
    height: 1123,
    scale: 0.95,
    margin: {
      top: '50px',
      right: '25px',
      bottom: '50px',
      left: '25px',
    },
  },
}

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
  .action((url, options) => {
    settings.url = url
    settings.outDir = options.outDir
    settings.timeout = options.timeout * 1000
  })

program.parse()

const downloadPage = async (browser, url, path, callback = null) => {
  const page = await browser.newPage()

  try {
    console.info('Downloading "%s" into "%s"', chalk.green(url), chalk.blue(path))

    const response = await page.goto(url.toString(), {
      waitUntil: 'load',
      timeout: settings.timeout,
    })

    if (!response.ok()) {
      throw new Error(`Received error response: "${chalk.red(response.statusText())}"`)
    }

    if (callback) {
      await callback(page)
    }

    await page.pdf({
      path,
      ...settings.pdfOptions,
    })
  } finally {
    await page.close()
  }
}

const collectLinks = content => {
  const $ = cheerio.load(content)

  const links = $('a[href^="/"]')
    .map((i, link) => $(link).attr('href'))
    .toArray()

  return new Set(links)
}

const href2slug = href => {
  let slug = slugify(href, {
    preserveCharacters: ['/']
  })

  slug = slug
    .replace(/\/+/g, '/')
    .trim()

  if (slug !== '/') {
    slug = slug.replace(/\/$/, '')
  }
  return slug
}

(async () => {
  // Chrome / Chromium cuts off lines in half when margins are applied, see
  // https://github.com/puppeteer/puppeteer/issues/8734#issuecomment-1234332415
  const browser = await puppeteer.launch({
    product: 'firefox'
  })
  const page = await browser.newPage()

  console.info('Visiting "%s"', chalk.green(settings.url))

  try {
    const response = await page.goto(settings.url, {
      waitUntil: 'load',
      timeout: settings.timeout,
    })
    if (!response.ok()) {
      console.error('Received error response: "%s"', chalk.red(response.statusText()))
      process.exit(1)
    }
  } catch (e) {
    console.error('Failed: %s', chalk.red(e))
    process.exit(1)
  }

  await page.evaluate(() => {
    // Expand all TOC menu items, so we have all of the links present in DOM
    const elements = document
      .querySelectorAll('a[data-rnwrdesktop-fnigne="true"] > div[tabindex="0"]')

    for (let element of elements) {
      element.click()
    }
  })

  const content = await page.content()
  const links = collectLinks(content)

  await page.close()

  console.info('Links collected: %O', links)

  for (let href of links) {
    let slug = href2slug(href)

    switch (slug) {
      case '':
        console.warn('Empty slug, ignoring "%s"', chalk.green(href))
        continue
      case '/':
        slug = 'index'
        break
    }

    const outPath = path.join(settings.outDir, `${slug}.pdf`)
    const outDir = path.dirname(outPath)

    // mkdir -p <path>
    await fs.mkdir(outDir, {
      recursive: true
    })

    const url = new URL(href, settings.url)

    try {
      await downloadPage(browser, url, outPath, async page => {
        await page.evaluate(() => {
          // Expand all expandable sections
          const sectionsToExpand = document
            .querySelectorAll('div[aria-controls^="expandable-body-"]')

          for (let section of sectionsToExpand) {
            section.click()
          }

          // Remove redundant/interactive elements
          const itemSelectorsToRemove = [
            'header + div[data-rnwrdesktop-hidden="true"]',
            'div[aria-label="Search…"]',
            'div[aria-label="Page actions"]',
          ]
          const itemsToRemove = document
            .querySelectorAll(itemSelectorsToRemove.join(', '))

          for (let item of itemsToRemove) {
            item.remove()
          }

          // Turn relative timestamps into absolute ones
          const lastModifiedEl = document
            .querySelector('div[dir="auto"] > span[aria-label]')

          if (lastModifiedEl) {
            lastModifiedEl.innerHTML = lastModifiedEl.getAttribute('aria-label')
          }
        })
      })
    } catch (e) {
      console.error('Downloading "%s" failed: %s', chalk.green(url), chalk.red(e))
    }
  }

  await browser.close()
})()
