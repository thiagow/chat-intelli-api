import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * PDF text extraction service using unpdf.
 *
 * Supported: PDFs with extractable text.
 * Not supported: scanned PDFs (images) — they require OCR.
 *
 * Installation: npm install unpdf
 */
@Injectable()
export class PdfExtractorService {
  private readonly logger = new Logger(PdfExtractorService.name);

  /**
   * Extract text from PDF buffer.
   *
   * @param buffer PDF file as Buffer
   * @param fileName Original file name (for logging/error messages)
   * @returns Extracted text
   * @throws BadRequestException if PDF is empty, unreadable, or has no extractable text
   */
  async extractText(buffer: Buffer, fileName: string = 'document.pdf'): Promise<string> {
    try {
      // Dynamically import unpdf (it's an ESM module)
      const { extractText: unpdfExtractText } = await import('unpdf');

      const data = new Uint8Array(buffer);
      const result = await unpdfExtractText(data);

      const text = Array.isArray(result.text) ? result.text.join('\n') : result.text || '';

      if (!text || text.trim().length === 0) {
        this.logger.warn(
          `PDF extraction resulted in empty text: ${fileName}. ` +
            'This is usually a scanned PDF (image-based) that requires OCR.',
        );
        throw new BadRequestException(
          'PDF sem texto extraível (possivelmente digitalizado). ' +
            'Envie um PDF com texto ou cole o conteúdo manualmente.',
        );
      }

      this.logger.log(`PDF extracted: ${fileName} (${text.length} chars)`);
      return text;
    } catch (error) {
      // If it's already our BadRequestException, re-throw
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `PDF extraction failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Generic error for parsing failures
      if (error instanceof Error && error.message.includes('PDF')) {
        throw new BadRequestException('PDF inválido ou corrompido. Tente novamente.');
      }

      throw new BadRequestException(
        'Erro ao processar PDF. Verifique se o arquivo é válido.',
      );
    }
  }
}
