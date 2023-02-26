import * as fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import * as cheerio from 'cheerio'
import slugify from '@sindresorhus/slugify'
import chalk from 'chalk'
import consola from 'consola'

export class Downloader {
  static defaults = {
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

  #logger = consola.create()

  constructor(settings = {}) {
    this.settings = { ...Downloader.defaults, ...settings }
    this.settings.timeout *= 1000 // s -> ms
  }

  async run(targetURL) {
    try {
      // Chrome / Chromium cuts off lines in half when margins are applied, see
      // https://github.com/puppeteer/puppeteer/issues/8734#issuecomment-1234332415
      this.browser = await puppeteer.launch({
        product: 'firefox'
      })
      await this.#runInternal(targetURL)
    } catch (e) {
      this.#logger.fatal(e.toString())
      throw e
    } finally {
      await this.browser?.close()
    }
  }

  async #runInternal(targetURL) {
    this.#logger.info('Visiting "%s"', chalk.green(targetURL))

    const page = await this.browser.newPage()

    const response = await page.goto(targetURL, {
      waitUntil: 'load',
      timeout: this.settings.timeout,
    })

    if (!response.ok()) {
      throw new Error(`${response.statusText()} (${response.status()})`)
    }

    this.#expandMenuLinks(page)

    const content = await page.content()
    const $ = cheerio.load(content)

    await page.close()

    if (!this.#isGitBookWebsite($)) {
      throw new Error('Not a GitBook website')
    }

    const links = this.#collectLinks($)

    this.#logger.debug('Links collected: %O', links)

    for (let href of links) {
      await this.#downloadLink(targetURL, href)
    }
  }

  async #downloadLink(targetURL, href) {
    const slug = this.#href2slug(href)

    if (!slug) {
      this.#logger.warn('Empty slug, ignoring "%s"', chalk.green(href))
      return
    }

    const outPath = path.join(this.settings.outDir, `${slug}.pdf`)
    const outDir = path.dirname(outPath)

    const url = new URL(href, targetURL)

    await this.#downloadPage(url, outPath, async page => {
      // mkdir -p <path>
      await fs.mkdir(outDir, {
        recursive: true
      })
      await this.#preparePage(page)
    })
  }

  async #expandMenuLinks(page) {
    await page.evaluate(() => {
      // Expand all TOC menu items, so we have all of the links present in DOM
      const elements = document
        .querySelectorAll('a[data-rnwrdesktop-fnigne="true"] > div[tabindex="0"]')

      for (let element of elements) {
        element.click()
      }
    })
  }

  async #preparePage(page) {
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
  }

  async #downloadPage(url, path, callback = null) {
    const page = await this.browser.newPage()

    try {
      this.#logger.info('Downloading "%s" into "%s"', chalk.green(url), chalk.blue(path))

      const response = await page.goto(url.toString(), {
        waitUntil: 'load',
        timeout: this.settings.timeout,
      })

      if (!response.ok()) {
        throw new Error(`${response.statusText()} (${response.status()})`)
      }

      await callback?.(page)

      await page.pdf({
        path,
        ...this.settings.pdfOptions,
      })
    } catch (e) {
      this.#logger.error('Downloading "%s" failed: %s', chalk.green(url), chalk.red(e))
    } finally {
      await page.close()
    }
  }

  #isGitBookWebsite($) {
    return $('body > .gitbook-root').length > 0
  }

  #collectLinks($) {
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

    slug = (slug === '/')
      ? 'index'
      : slug.replace(/\/$/, '')

    return slug
  }
}
