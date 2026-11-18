import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

export type CatalogPdfProduct = {
  id: string

  name: string

  model: string

  version: string | null

  brand: string | null

  category: string | null

  description: string | null

  specs: Array<{
    label: string
    value: string
  }>

  priceText: string | null

  salePriceText: string | null

  cardInstallments: string | null

  cardInstallmentText: string | null
}

export type CatalogPdfImage = {
  mime: string

  bytes: Uint8Array
}

const PAGE_WIDTH = 595

const PAGE_HEIGHT = 842

const LEFT = 42

const BOTTOM = 42

function printable(value: string) {
  return value.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, " ")
}

function wrapText(
  value: string,

  width: number,

  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,

  size: number,
) {
  const words = printable(value).split(/\s+/).filter(Boolean)

  const lines: string[] = []

  let line = ""

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word

    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line)

      line = word
    } else {
      line = candidate
    }
  }

  if (line) lines.push(line)

  return lines.length ? lines : [""]
}

export async function createCatalogPdf(
  products: CatalogPdfProduct[],

  images: Map<string, CatalogPdfImage[]>,

  financingNote: string,
) {
  const pdf = await PDFDocument.create()

  const regular = await pdf.embedFont(StandardFonts.Helvetica)

  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  pdf.setTitle("Catálogo completo de scooters")

  pdf.setSubject(products.map((product) => product.id).join(","))

  pdf.setCreator("AV Flow CRM")

  pdf.setKeywords(products.map((product) => product.id))

  for (const product of products) {
    let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])

    let y = PAGE_HEIGHT - 54

    const productImages = images.get(product.id) ?? []

    page.drawText(printable(product.name), {
      x: LEFT,

      y,

      size: 20,

      font: bold,

      color: rgb(0.08, 0.19, 0.15),
    })

    y -= 28

    const detailWidth = PAGE_WIDTH - LEFT * 2

    const drawParagraph = (label: string, value: string | null) => {
      if (!value?.trim()) return

      const lines = wrapText(`${label}: ${value}`, detailWidth, regular, 10)

      for (const line of lines) {
        if (y < BOTTOM) {
          page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])

          y = PAGE_HEIGHT - 54

          page.drawText(
            printable(`${product.name} - continuação`),

            { x: LEFT, y, size: 14, font: bold, color: rgb(0.08, 0.19, 0.15) },
          )

          y -= 24
        }

        page.drawText(line, {
          x: LEFT,

          y,

          size: 10,

          font: regular,

          color: rgb(0.16, 0.2, 0.18),
        })

        y -= 14
      }

      y -= 3
    }

    drawParagraph(
      "Modelo",
      `${product.model}${product.version ? ` ${product.version}` : ""}`,
    )

    drawParagraph("Marca", product.brand)

    drawParagraph("Categoria", product.category)

    drawParagraph("Preço", product.priceText)

    drawParagraph("Preço promocional", product.salePriceText)

    drawParagraph(
      "Cartão",

      product.cardInstallments && product.cardInstallmentText
        ? `${product.cardInstallments}x de ${product.cardInstallmentText}`
        : product.cardInstallmentText,
    )

    drawParagraph("Disponibilidade", "Consulte a equipe da loja.")

    drawParagraph("Descrição", product.description)

    for (const spec of product.specs) drawParagraph(spec.label, spec.value)

    drawParagraph("Financiamento", financingNote)

    let photoPage: typeof page | null = null
    let photoColumn = 0
    let photoTop = PAGE_HEIGHT - 100
    const openPhotoPage = () => {
      photoPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      photoPage.drawText(printable(`${product.name} - fotos`), {
        x: LEFT,
        y: PAGE_HEIGHT - 54,
        size: 14,
        font: bold,
        color: rgb(0.08, 0.19, 0.15),
      })
      photoColumn = 0
      photoTop = PAGE_HEIGHT - 100
    }

    for (const [imageIndex, image] of productImages.entries()) {
      try {
        const embedded =
          image.mime === "image/png"
            ? await pdf.embedPng(image.bytes)
            : image.mime === "image/jpeg"
              ? await pdf.embedJpg(image.bytes)
              : null

        if (!embedded) continue
        if (!photoPage || (photoColumn === 0 && photoTop - 120 < BOTTOM))
          openPhotoPage()

        const scale = Math.min(150 / embedded.width, 120 / embedded.height)
        const width = embedded.width * scale
        const height = embedded.height * scale
        photoPage!.drawImage(embedded, {
          x: LEFT + photoColumn * 170,
          y: photoTop - height,
          width,
          height,
        })
        photoColumn++
        if (photoColumn === 3) {
          photoColumn = 0
          photoTop -= 160
        }
      } catch (error) {
        console.warn("catalog_pdf_image_embed_failed", {
          productId: product.id,
          imageIndex,
          error: error instanceof Error ? error.message : "unknown",
        })
      }
    }
  }

  return pdf.save({ useObjectStreams: false })
}
