const PDFJS_ASSETS = '/foliate-pdfjs/'

const pdfjsAsset = (subpath) => `${PDFJS_ASSETS}${subpath}`

await import('foliate-pdfjs-lib')

const pdfjsLib = globalThis.pdfjsLib
if (!pdfjsLib) {
  throw new Error('PDF.js failed to load')
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsAsset('pdf.worker.mjs')

const fetchText = async (url) => await (await fetch(url)).text()

const annotationLayerBuilderCSS = await fetchText(
  pdfjsAsset('annotation_layer_builder.css'),
)

const render = async (page, doc, zoom) => {
  const scale = zoom * devicePixelRatio
  doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
  doc.documentElement.style.transformOrigin = 'top left'
  doc.documentElement.style.setProperty('--scale-factor', scale)
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.height = viewport.height
  canvas.width = viewport.width
  const canvasContext = canvas.getContext('2d')
  await page.render({ canvasContext, viewport }).promise
  doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

  for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement')) {
    Object.assign(hiddenCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      display: 'none',
    })
  }

  const div = doc.querySelector('.annotationLayer')
  if (div) {
    const linkService = {
      goToDestination: () => {},
      getDestinationHash: (dest) => JSON.stringify(dest),
      addLinkAttributes: (link, url) => {
        link.href = url
      },
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
      annotations: await page.getAnnotations(),
    })
  }
}

const renderPage = async (page, getImageBlob) => {
  const viewport = page.getViewport({ scale: 1 })
  if (getImageBlob) {
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    return new Promise((resolve) => canvas.toBlob(resolve))
  }
  const src = URL.createObjectURL(
    new Blob(
      [
        `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
            user-select: none;
            -webkit-user-select: none;
            cursor: default;
        }
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${annotationLayerBuilderCSS}
        .annotationLayer {
          pointer-events: none;
        }
        </style>
        <div id="canvas"></div>
        <div class="annotationLayer"></div>
    `,
      ],
      { type: 'text/html' },
    ),
  )
  const onZoom = ({ doc, scale }) => render(page, doc, scale)
  return { src, onZoom }
}

const makeTOCItem = (item) => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async (file) => {
  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
  transport.requestDataRange = (begin, end) => {
    file.slice(begin, end).arrayBuffer().then((chunk) => {
      transport.onDataRange(begin, chunk)
    })
  }
  const pdf = await pdfjsLib.getDocument({
    range: transport,
    cMapUrl: pdfjsAsset('cmaps/'),
    standardFontDataUrl: pdfjsAsset('standard_fonts/'),
    wasmUrl: pdfjsAsset('wasm/'),
    isEvalSupported: false,
  }).promise

  const book = { rendition: { layout: 'pre-paginated', spread: 'none' } }

  const { metadata, info } = (await pdf.getMetadata()) ?? {}
  book.metadata = {
    title: metadata?.get('dc:title') ?? info?.Title,
    author: metadata?.get('dc:creator') ?? info?.Author,
    contributor: metadata?.get('dc:contributor'),
    description: metadata?.get('dc:description') ?? info?.Subject,
    language: metadata?.get('dc:language'),
    publisher: metadata?.get('dc:publisher'),
    subject: metadata?.get('dc:subject'),
    identifier: metadata?.get('dc:identifier'),
    source: metadata?.get('dc:source'),
    rights: metadata?.get('dc:rights'),
  }

  const outline = await pdf.getOutline()
  book.toc = outline?.map(makeTOCItem)

  const cache = new Map()
  book.sections = Array.from({ length: pdf.numPages }).map((_, index) => ({
    id: index,
    load: async () => {
      const cached = cache.get(index)
      if (cached) return cached
      const url = await renderPage(await pdf.getPage(index + 1))
      cache.set(index, url)
      return url
    },
    size: 1000,
  }))
  book.isExternal = (uri) => /^\w+:/i.test(uri)
  book.resolveHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest =
      typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return { index }
  }
  book.splitTOCHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest =
      typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return [index, null]
  }
  book.getTOCFragment = (doc) => doc.documentElement
  book.getCover = async () => renderPage(await pdf.getPage(1), true)
  book.destroy = () => pdf.destroy()
  return book
}
