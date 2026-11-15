// ==========================================================
// utils.js — funções pequenas e reutilizáveis
// Responsabilidade: converter dinheiro (reais <-> centavos) e
// trabalhar com datas no formato "AAAA-MM-DD". Não conhece o banco
// nem a tela.
//
// Convenção do projeto: datas são SEMPRE texto "AAAA-MM-DD" e meses
// são texto "AAAA-MM". Texto nesse formato tem uma vantagem: a ordem
// alfabética é igual à ordem cronológica, então comparar com < e >
// funciona e o IndexedDB consegue buscar por intervalos.
// ==========================================================

// ---------------------------------------------------------
// DINHEIRO
// ---------------------------------------------------------

/**
 * Converte o texto digitado pelo usuário em CENTAVOS (número inteiro).
 *   "25,90"       -> 2590
 *   "R$ 1.234,56" -> 123456
 *   "25.9"        -> 2590
 *
 * Por que centavos? Em JavaScript, 0.1 + 0.2 dá 0.30000000000000004.
 * Com números inteiros esse tipo de erro não existe.
 *
 * Repare que NÃO multiplicamos por 100 um número decimal: separamos
 * o texto em "parte inteira" e "centavos" e montamos o resultado só
 * com inteiros.
 */
export function reaisParaCentavos(texto) {
  // Tira "R$" e espaços
  let limpo = String(texto).replace(/R\$|\s/g, '');

  // Formato brasileiro: ponto separa milhar, vírgula separa decimal.
  // Com vírgula, o ponto só é aceito como separador de milhar (grupos de
  // 3 dígitos): "1.234,56" vale; "1,5.5" e "12.5,00" são recusados em vez
  // de serem "adivinhados" e gravados com outro valor.
  if (limpo.includes(',')) {
    if (!/^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(limpo)) {
      throw new Error('Valor inválido. Use o formato 25,90');
    }
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  }

  // Só aceitamos: dígitos, e opcionalmente ponto + 1 ou 2 casas decimais
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) {
    throw new Error('Valor inválido. Use o formato 25,90');
  }

  const [parteInteira, parteDecimal = ''] = limpo.split('.');
  // padEnd: "9" vira "90" (25,9 = 25 reais e 90 centavos)
  const centavos = Number(parteInteira) * 100 + Number(parteDecimal.padEnd(2, '0'));

  // Proteção: acima disso o número deixaria de ser inteiro "seguro" no JS
  if (!Number.isSafeInteger(centavos)) {
    throw new Error('Valor grande demais.');
  }
  return centavos;
}

/**
 * Converte centavos em texto para mostrar na tela.
 *   2590 -> "R$ 25,90"
 */
export function centavosParaReais(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/**
 * Converte centavos em texto para preencher um campo de formulário
 * (sem "R$", para o usuário poder editar). 2590 -> "25,90"
 */
export function centavosParaCampo(centavos) {
  const reais = Math.floor(centavos / 100);
  const resto = String(centavos % 100).padStart(2, '0');
  return `${reais},${resto}`;
}

/**
 * Versão curta para gráficos, sem casas decimais.
 *   85000 -> "850"      123456 -> "1,2 mil"
 */
export function formatarCompacto(centavos) {
  const reais = centavos / 100;
  if (reais >= 1000) {
    return (reais / 1000).toFixed(1).replace('.', ',') + ' mil';
  }
  return String(Math.round(reais));
}

// ---------------------------------------------------------
// DATAS
// ---------------------------------------------------------

/** Quebra "2026-11-06" em { ano: 2026, mes: 11, dia: 6 } (números). */
export function parseISO(iso) {
  const [ano, mes, dia] = iso.split('-').map(Number);
  return { ano, mes, dia };
}

/** Monta "AAAA-MM-DD" a partir de números. */
export function montarISO(ano, mes, dia) {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Quantos dias tem o mês (mes de 1 a 12). Considera ano bissexto. */
export function diasNoMes(ano, mes) {
  // Date.UTC(ano, mes, 0): "dia 0 do mês seguinte" = último dia deste mês.
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Confere se o texto é uma data REAL no formato AAAA-MM-DD.
 * "2026-02-31" tem o "jeitão" certo, mas não existe — aqui é recusada.
 */
export function isValidISODate(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const { ano, mes, dia } = parseISO(texto);
  if (ano < 1900 || mes < 1 || mes > 12 || dia < 1) return false;
  return dia <= diasNoMes(ano, mes);
}

/**
 * Data de hoje no formato "AAAA-MM-DD", no fuso do SEU celular/computador.
 *
 * Cuidado clássico: new Date().toISOString() usa o horário UTC.
 * No Brasil (UTC-3), depois das 21h o UTC já está no dia seguinte,
 * e a despesa ficaria com a data errada. Por isso montamos a data
 * "na mão" com getFullYear/getMonth/getDate (que usam o horário local).
 */
export function hojeISO() {
  const agora = new Date();
  return montarISO(agora.getFullYear(), agora.getMonth() + 1, agora.getDate());
}

/** Mês atual no formato "AAAA-MM" (ex.: "2026-11"). */
export function mesAtualISO() {
  return hojeISO().slice(0, 7);
}

/**
 * Soma (ou subtrai, com n negativo) meses a uma data.
 * Se o dia não existir no mês de destino, usa o último dia dele:
 *   somarMeses("2026-01-31", 1) -> "2026-02-28"
 * Sempre calcule a partir da data ORIGINAL (não da anterior), senão
 * o dia "encolhe" e nunca mais volta: 31/01 -> 28/02 -> 28/03...
 */
export function somarMeses(iso, n) {
  const { ano, mes, dia } = parseISO(iso);
  const total = ano * 12 + (mes - 1) + n;
  const novoAno = Math.floor(total / 12);
  const novoMes = (total % 12) + 1;
  const novoDia = Math.min(dia, diasNoMes(novoAno, novoMes));
  return montarISO(novoAno, novoMes, novoDia);
}

/** Desloca um mês "AAAA-MM" em delta meses. deslocarMes("2026-01", -1) -> "2025-12" */
export function deslocarMes(anoMes, delta) {
  return somarMeses(`${anoMes}-01`, delta).slice(0, 7);
}

/**
 * Quantos dias passaram de `de` até `ate` (ambos "AAAA-MM-DD").
 * Positivo se `ate` é depois. Usa UTC só para a conta não ser afetada
 * pelo horário de verão.
 */
export function diasEntre(de, ate) {
  const a = parseISO(de);
  const b = parseISO(ate);
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(b.ano, b.mes - 1, b.dia) - Date.UTC(a.ano, a.mes - 1, a.dia)) / msPorDia);
}

/** Primeira letra maiúscula: "novembro de 2026" -> "Novembro de 2026". */
export function capitalizar(texto) {
  return texto ? texto[0].toUpperCase() + texto.slice(1) : texto;
}

/** "2026-11-06" -> "06/11/2026" */
export function formatarData(iso) {
  const { ano, mes, dia } = parseISO(iso);
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`;
}

/** "2026-11-06" -> "06/11" */
export function formatarDataCurta(iso) {
  return formatarData(iso).slice(0, 5);
}

/** "2026-11-06" -> "sexta-feira, 06 de novembro" */
export function formatarDataLonga(iso) {
  const { ano, mes, dia } = parseISO(iso);
  return new Date(ano, mes - 1, dia).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  });
}

/** "2026-11" -> "novembro de 2026" */
export function nomeDoMes(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  return new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  });
}

/** "2026-11" -> "novembro" */
export function nomeMesLongo(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  return new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
}

/** "2026-11" -> "nov" */
export function nomeMesCurto(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  return new Date(ano, mes - 1, 1)
    .toLocaleDateString('pt-BR', { month: 'short' })
    .replace('.', '');
}
