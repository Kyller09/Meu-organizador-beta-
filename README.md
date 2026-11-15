# Meu Organizador

Aplicativo pessoal de **gastos, parcelas e agenda**, feito como PWA com HTML, CSS e JavaScript puros.
Funciona offline, sem login, sem servidor externo e sem dependências (não há `npm install`).

## Como rodar no computador

1. Abra a pasta `MeuOrganizador` no VS Code (Arquivo → Abrir Pasta).
2. Instale a extensão **Live Server**.
3. Clique com o botão direito em `index.html` → **Open with Live Server** (porta padrão 5500).
4. No navegador, F12 → ícone de celular para ver em tamanho de telefone.

## Como instalar no Android

**Opção A: cabo USB (recomendada, já é endereço seguro)**

1. No celular: Configurações → Opções do desenvolvedor → ative **Depuração USB**.
2. Conecte o cabo e autorize o computador no celular.
3. No terminal do VS Code: `adb devices` (deve listar o aparelho) e depois `adb reverse tcp:5500 tcp:5500`.
4. Com o Live Server rodando, abra o **Chrome do celular** em `http://localhost:5500`.
5. Menu ⋮ do Chrome → **Instalar app** (ou "Adicionar à tela inicial").
6. Abra o app uma vez com o servidor ligado, para o Service Worker guardar os arquivos. Depois disso o
   servidor pode ser desligado: o app abre offline.

> `localhost` conta como endereço seguro, por isso o Service Worker, o PIN e as notificações funcionam.
> Abrir por `http://192.168.x.x:5500` (Wi-Fi) **não** é seguro: o app abre, mas sem offline, sem PIN e sem notificações.

**Opção B: hospedar de graça (HTTPS)** em GitHub Pages, Netlify etc. Só os arquivos estáticos da pasta,
sem dados pessoais (os dados ficam no celular, nunca no servidor).

## Mapa do código

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Estrutura de todas as telas e diálogos |
| `css/style.css` | Identidade visual dark; as cores ficam nas variáveis do topo (`:root`) |
| `js/app.js` | Inicialização: liga as telas, o PIN, o Service Worker e o vigia de lembretes |
| `js/nav.js` | Troca de tela |
| `js/ui.js` | Criar elementos com segurança (`el`), toasts, diálogo de confirmação, aviso de "dados mudaram" |
| `js/utils.js` | Dinheiro (reais↔centavos) e datas |
| `js/database.js` | IndexedDB: abrir/migrar o banco, CRUD genérico, transações em várias tabelas |
| `js/expenses.js` | Despesas, totais por mês e por categoria |
| `js/installments.js` | Compras parceladas, divisão em centavos, pagar/desfazer sem duplicar |
| `js/calendar.js` | Compromissos e lembretes |
| `js/backup.js` | Exportar, validar e restaurar backup |
| `js/security.js` | PIN com hash PBKDF2 e tela de bloqueio |
| `js/views/*.js` | Desenho de cada tela (Início, Gastos, Parcelas, Agenda, Ajustes) |
| `manifest.json` | Dados de instalação do PWA |
| `service-worker.js` | Cache e funcionamento offline |

## Regras importantes do projeto

- **Dinheiro em centavos inteiros** (`R$ 25,90` = `2590`). Nunca some decimais em JavaScript.
- **Datas como texto `AAAA-MM-DD`** e meses `AAAA-MM` (a ordem alfabética é a cronológica).
- **Parcela não conta em dobro:** parcela pendente não entra nos gastos. Ao pagar, nasce **uma** despesa
  ligada à parcela (`sourceKey = "installment:<id>"`), na mesma transação. Ao desfazer, a despesa some.
  O gasto entra na data em que a parcela foi **paga**, não na do vencimento.
- **Nunca monte HTML juntando texto do usuário.** Use `el()` do `ui.js` (usa `textContent`).
- **Mudou a estrutura do banco?** Aumente `DB_VERSION` em `database.js` e acrescente um bloco `if` na migração.
- **Criou um arquivo novo?** Acrescente-o em `ARQUIVOS` no `service-worker.js` e aumente `VERSAO`.

## Limitações (leia)

- **Os dados vivem só no navegador do celular.** Limpar dados do site, desinstalar o Chrome ou trocar de
  aparelho apaga tudo. **Faça backup** em Ajustes → Exportar (o app avisa se passar de 30 dias). Guarde o
  arquivo fora do celular (Drive, e-mail para você mesmo, computador).
- **Lembretes:** só disparam com o app aberto (ou ao voltar a ele). O Android não permite alarmes exatos para
  PWAs com o app fechado. Não use como único despertador para algo importante.
- **PIN:** é uma tranca de tela. Não criptografa os dados; quem tiver acesso técnico ao navegador consegue
  lê-los. Não há recuperação de PIN: se esquecer, limpar os dados do site remove o PIN **e apaga os registros**
  (por isso o backup). Biometria foi avaliada e não implementada (exigiria WebAuthn).
- **Armazenamento:** em Ajustes dá para pedir "armazenamento protegido", que evita a limpeza automática
  em aparelhos com pouco espaço.

## Atualizar o app já instalado

O Service Worker usa **rede primeiro**: com o servidor ligado, o app sempre carrega a versão mais nova e
atualiza o cache; sem servidor, usa o cache. Ao mudar arquivos, basta abrir o app com o servidor ligado
(e recarregar uma vez).

> Limitação conhecida: logo depois de uma atualização, com internet muito lenta, o app pode misturar arquivos
> novos e antigos e mostrar tela em branco. Recarregar a página (com o servidor ligado) resolve.

## Checklist de teste manual no celular

- [ ] App instalado abre em tela cheia, com ícone próprio
- [ ] Adicionar, editar, excluir (e "Desfazer") um gasto
- [ ] Cadastrar compra em 3x, pagar uma parcela e ver o total do mês subir uma vez só
- [ ] Desfazer o pagamento e ver o total voltar
- [ ] Criar compromisso com lembrete, ativar notificações e deixar o app aberto até o horário
- [ ] Exportar backup, apagar um gasto, restaurar o backup e ver o gasto de volta
- [ ] Ativar PIN, fechar o app, abrir de novo e desbloquear
- [ ] **Desligar o Live Server e o Wi-Fi/dados e abrir o app: deve abrir e mostrar os dados**
