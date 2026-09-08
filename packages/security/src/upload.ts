/**
 * Validação de upload de mídia clínica.
 *
 * ## O que a especificação listava no threat model e não detalhava
 *
 * "Upload de arquivo malicioso" e "acesso indevido a fotos/vídeos clínicos".
 * Este arquivo define as regras concretas.
 *
 * ## Por que confiar no `Content-Type` é errado
 *
 * O `Content-Type` do multipart e a extensão do arquivo vêm do cliente — os
 * dois são texto que o atacante escolhe. `laudo.pdf.php` com
 * `Content-Type: image/jpeg` passaria em qualquer checagem ingênua. A única
 * verificação que vale é ler os primeiros bytes do arquivo e conferir a
 * assinatura (*magic number*), que é o que `detectarTipo` faz.
 *
 * ## Camadas de defesa
 *
 * 1. Extensão e MIME declarados servem só para recusar cedo, nunca para aceitar.
 * 2. Assinatura binária decide o tipo real.
 * 3. Nome do arquivo é **descartado**, não sanitizado — guardamos com um UUID.
 *    Sanitizar nome é um jogo de gato e rato (`..`, NTFS ADS, unicode
 *    homóglifo); não usar o nome do cliente encerra o jogo.
 * 4. Arquivo vai para storage privado, servido só por rota autenticada que
 *    grava `MIDIA_ACESSADA` na auditoria. Nunca em diretório estático público.
 * 5. Metadados EXIF são removidos de imagem — foto de celular carrega
 *    **coordenada GPS** e número de série do aparelho, o que num contexto de
 *    atendimento domiciliar significa o endereço do paciente.
 */

/** Tipos aceitos, com sua assinatura binária. */
interface TipoPermitido {
  /** MIME canônico, definido por nós, não pelo cliente. */
  mime: string;
  /** Extensão que usaremos ao gravar. */
  extensao: string;
  /** Bytes iniciais que identificam o formato. */
  assinatura: number[];
  /** Deslocamento em que a assinatura começa. */
  offset: number;
  /** Tamanho máximo em bytes para este tipo. */
  maximoBytes: number;
}

/** 12 MiB para imagem. Foto de celular moderna cabe folgado. */
const MAX_IMAGEM = 12 * 1024 * 1024;
/** 120 MiB para vídeo de movimento. Vídeo clínico é curto por natureza. */
const MAX_VIDEO = 120 * 1024 * 1024;

/**
 * Catálogo de tipos aceitos.
 *
 * Lista de permissão fechada. SVG está **deliberadamente fora**: SVG é XML e
 * pode carregar `<script>`, o que faz de um "upload de imagem" um XSS
 * armazenado servido do nosso próprio domínio.
 */
const TIPOS: TipoPermitido[] = [
  { mime: 'image/jpeg', extensao: 'jpg', assinatura: [0xff, 0xd8, 0xff], offset: 0, maximoBytes: MAX_IMAGEM },
  { mime: 'image/png', extensao: 'png', assinatura: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, maximoBytes: MAX_IMAGEM },
  { mime: 'image/webp', extensao: 'webp', assinatura: [0x57, 0x45, 0x42, 0x50], offset: 8, maximoBytes: MAX_IMAGEM },
  // MP4/MOV: a caixa `ftyp` começa no byte 4; os 4 primeiros são o tamanho.
  { mime: 'video/mp4', extensao: 'mp4', assinatura: [0x66, 0x74, 0x79, 0x70], offset: 4, maximoBytes: MAX_VIDEO },
  { mime: 'video/webm', extensao: 'webm', assinatura: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, maximoBytes: MAX_VIDEO },
];

/** Por que um upload foi recusado. Vira `UPLOAD_RECUSADO` na auditoria. */
export type RecusaUpload =
  | 'tipo_nao_permitido' // Assinatura não corresponde a nenhum tipo aceito.
  | 'tamanho_excedido' // Maior que o teto do tipo.
  | 'arquivo_vazio'
  | 'assinatura_divergente'; // O tipo declarado não bate com o real — suspeito.

/** Resultado da validação. */
export type ResultadoUpload =
  | { ok: true; mime: string; extensao: string; ehImagem: boolean }
  | { ok: false; recusa: RecusaUpload };

/**
 * Identifica o tipo real de um arquivo pela assinatura binária.
 *
 * @param buffer Bytes do arquivo. Bastam os primeiros 16, mas aceita o todo.
 * @returns      O tipo encontrado, ou `null`.
 */
export function detectarTipo(buffer: Buffer): TipoPermitido | null {
  for (const tipo of TIPOS) {
    const fim = tipo.offset + tipo.assinatura.length;
    if (buffer.length < fim) continue;

    // Compara byte a byte a partir do offset do formato.
    const bate = tipo.assinatura.every((b, i) => buffer[tipo.offset + i] === b);
    if (bate) return tipo;
  }
  return null;
}

/**
 * Valida um upload por completo.
 *
 * @param buffer         Bytes do arquivo.
 * @param mimeDeclarado  `Content-Type` informado pelo cliente. Usado apenas
 *                       para detectar tentativa de engano — nunca para aceitar.
 */
export function validarUpload(buffer: Buffer, mimeDeclarado: string): ResultadoUpload {
  if (buffer.length === 0) return { ok: false, recusa: 'arquivo_vazio' };

  const tipo = detectarTipo(buffer);
  if (!tipo) return { ok: false, recusa: 'tipo_nao_permitido' };

  if (buffer.length > tipo.maximoBytes) {
    return { ok: false, recusa: 'tamanho_excedido' };
  }

  // O cliente declarou um tipo diferente do real? Não é apenas um engano de
  // navegador — é o padrão de quem tenta subir executável com cara de imagem.
  // Recusamos e auditamos, em vez de aceitar silenciosamente.
  if (mimeDeclarado && !mimeDeclarado.startsWith(tipo.mime.split('/')[0] ?? '')) {
    return { ok: false, recusa: 'assinatura_divergente' };
  }

  return {
    ok: true,
    mime: tipo.mime,
    extensao: tipo.extensao,
    ehImagem: tipo.mime.startsWith('image/'),
  };
}

/**
 * Remove metadados EXIF de um JPEG.
 *
 * Percorre os segmentos do arquivo e descarta os marcadores APP1 (EXIF/XMP) e
 * APP2 — onde ficam GPS, modelo do aparelho, número de série e miniatura
 * embutida. A miniatura importa: ela sobrevive ao recorte da imagem principal
 * e já revelou conteúdo que o usuário achava ter apagado.
 *
 * PNG e WebP não carregam EXIF na prática (e quando carregam, é em chunks
 * opcionais que ignoramos ao reescrever). Vídeo exigiria remultiplexação com
 * ffmpeg — está documentado como pendência em `docs/security-model.md`.
 *
 * @param jpeg Bytes do JPEG original.
 * @returns    JPEG sem os segmentos de metadado, ou o original se não for JPEG.
 */
export function removerExif(jpeg: Buffer): Buffer {
  // SOI (Start Of Image): todo JPEG começa com FF D8.
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;

  const pedacos: Buffer[] = [jpeg.subarray(0, 2)]; // Mantém o SOI.
  let i = 2;

  while (i < jpeg.length - 1) {
    // Todo marcador começa com 0xFF. Se não começar, o arquivo está corrompido
    // ou já chegamos aos dados comprimidos — devolvemos o resto como está.
    if (jpeg[i] !== 0xff) break;

    const marcador = jpeg[i + 1] as number;

    // SOS (Start Of Scan, 0xDA): daqui em diante são os dados da imagem.
    if (marcador === 0xda) {
      pedacos.push(jpeg.subarray(i));
      break;
    }

    // Marcadores sem payload (RSTn, TEM): só 2 bytes.
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      pedacos.push(jpeg.subarray(i, i + 2));
      i += 2;
      continue;
    }

    // Demais marcadores trazem um comprimento de 2 bytes (big-endian) que
    // inclui os próprios 2 bytes.
    const comprimento = jpeg.readUInt16BE(i + 2);
    const fimSegmento = i + 2 + comprimento;
    if (fimSegmento > jpeg.length) break; // Comprimento inválido: para por aqui.

    // APP1 (0xE1) = EXIF/XMP · APP2 (0xE2) = ICC/FlashPix · COM (0xFE) = comentário.
    const ehMetadado = marcador === 0xe1 || marcador === 0xe2 || marcador === 0xfe;
    if (!ehMetadado) pedacos.push(jpeg.subarray(i, fimSegmento));

    i = fimSegmento;
  }

  return Buffer.concat(pedacos);
}

/**
 * Cabeçalhos obrigatórios ao servir mídia clínica.
 *
 * `Content-Disposition: attachment` força download em vez de renderização.
 * Se um arquivo malicioso passar por todas as camadas anteriores, ele ainda
 * não executa no contexto da nossa origem. `X-Content-Type-Options: nosniff`
 * impede o navegador de "adivinhar" um tipo diferente do que declaramos.
 */
export function cabecalhosMidia(mime: string, nomeParaDownload: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${nomeParaDownload.replace(/[^\w.-]/g, '_')}"`,
    // Mídia clínica nunca em cache compartilhado nem em disco do navegador.
    'Cache-Control': 'private, no-store, max-age=0',
    // Sandbox extra: mesmo baixado e aberto, sem script, sem plugin, sem form.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}
