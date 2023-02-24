import * as fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import * as cheerio from 'cheerio'
import slugify from '@sindresorhus/slugify'
import chalk from 'chalk'

export class Downloader {
  defaults = {
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

  constructor(settings = {}) {
    this.settings = { ...this.defaults, ...settings }
    this.settings.timeout *= 1000 // s -> ms
  }

  async run(targetURL) {
    // Chrome / Chromium cuts off lines in half when margins are applied, see
    // https://github.com/puppeteer/puppeteer/issues/8734#issuecomment-1234332415
    this.browser = await puppeteer.launch({
      product: 'firefox'
    })
    const page = await this.browser.newPage()

    console.info('Visiting "%s"', chalk.green(targetURL))

    try {
      const response = await page.goto(targetURL, {
        waitUntil: 'load',
        timeout: this.settings.timeout,
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
    const links = this.#collectLinks(content)

    await page.close()

    console.info('Links collected: %O', links)

    for (let href of links) {
      let slug = this.#href2slug(href)

      switch (slug) {
        case '':
          console.warn('Empty slug, ignoring "%s"', chalk.green(href))
          continue
        case '/':
          slug = 'index'
          break
      }

      const outPath = path.join(this.settings.outDir, `${slug}.pdf`)
      const outDir = path.dirname(outPath)

      // mkdir -p <path>
      await fs.mkdir(outDir, {
        recursive: true
      })

      const url = new URL(href, targetURL)

      try {
        await this.#downloadPage(url, outPath, async page => {
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

    await this.browser.close()
  }

  async #downloadPage(url, path, callback = null) {
    const page = await this.browser.newPage()

    try {
      console.info('Downloading "%s" into "%s"', chalk.green(url), chalk.blue(path))

      const response = await page.goto(url.toString(), {
        waitUntil: 'load',
        timeout: this.settings.timeout,
      })

      if (!response.ok()) {
        throw new Error(`Received error response: "${chalk.red(response.statusText())}"`)
      }

      if (callback) {
        await callback(page)
      }

      await page.pdf({
        path,
        ...this.settings.pdfOptions,
      })
    } finally {
      await page.close()
    }
  }

  #collectLinks(content) {
    const $ = cheerio.load(content)

    const links = $('a[href^="/"]')
      .map((i, link) => $(link).attr('href'))
      .toArray()

    return new Set(links)
  }

  #href2slug(href) {
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
}
