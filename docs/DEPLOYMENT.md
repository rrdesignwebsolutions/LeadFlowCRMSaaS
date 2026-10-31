# Implantação e integrações externas

## Cloudflare

1. Instale dependências com `pnpm install`.
2. Autentique o Wrangler e crie o banco: `pnpm wrangler d1 create av-flow-crm-db`.
3. Copie o `database_id` retornado para `wrangler.toml`.
4. Aplique: `pnpm db:migrate:remote`.
5. Cadastre segredos: `pnpm wrangler secret put SESSION_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN` e `ENCRYPTION_KEY`.
6. Ajuste `APP_ORIGIN`, execute `pnpm build` e `pnpm cf:deploy`.
7. Configure domínio customizado e confirme HTTPS, cookies, CSP e logs sem payloads sensíveis.

Para desenvolvimento, copie `.dev.vars.example` para `.dev.vars` (arquivo ignorado) e use valores locais. Nunca commite segredos.

## Meta — checklist manual obrigatório

No Meta for Developers: crie um app do tipo apropriado ao caso vigente; adicione WhatsApp; configure empresa, domínios e a URL pública `https://leadflowcrmsaas.contato-167.workers.dev/privacy.html`; registre a URL pública `/api/webhooks/meta`; use o mesmo verify token do secret; assine `messages` e `account_update`; configure o Embedded Signup v4; solicite permissões e acesso avançado exigidos pela documentação atual; conclua verificação empresarial e requisitos de Tech Provider quando aplicáveis. Defina `META_APP_ID` e `META_CONFIG_ID` nas vars do Worker e `META_APP_SECRET` como secret. O fluxo troca o código de uso único no backend e guarda o token resultante criptografado com `ENCRYPTION_KEY`.

Teste primeiro com o número de teste e use o fluxo Embedded Signup v4 integrado em Configurações. O callback fornece WABA ID, Phone Number ID e código de autorização de curta duração; o Worker troca o código imediatamente. No Login do Facebook para Empresas, habilite as opções OAuth e Login com SDK JavaScript exigidas pela documentação atual e permita o domínio HTTPS do app. Confirme `whatsapp_business_management` e `whatsapp_business_messaging` conforme o fluxo aprovado. A implementação está no repositório; App Review, acesso avançado, elegibilidade e liberação para produção dependem da Meta.

Coexistência não deve ser oferecida sem o fluxo oficial habilitado e confirmação de elegibilidade. Antes de conectar, informe impactos sobre o aplicativo atual e histórico; nunca migre ou remova um número automaticamente.

## Diagnóstico

- Verificação falha: confira URL HTTPS, verify token e parâmetros `hub.*`.
- POST 401: compare App Secret e assinatura do corpo bruto.
- Evento sem empresa: `phone_number_id` não está associado de forma única a uma integração conectada.
- Envio 401/403: token, permissões, app review ou ativo empresarial incorretos.
- Modelo obrigatório: janela de atendimento encerrada; enviar apenas template aprovado.

## Rollback, backup e custos

Use versões de deploy do Cloudflare para rollback e migrações aditivas; não reverta schema destrutivamente sem backup/export. Agende exportação D1, teste restauração e restrinja acesso. Workers, D1, Queues e R2 têm franquias e limites que mudam; consulte as páginas oficiais antes do lançamento e configure alertas. A Meta pode cobrar mensagens conforme categoria, país e janela vigente. Não há promessa de custo zero.

## Pendências antes de produção

- Provisionar D1 e aplicar migração.
- Implementar recuperação de senha por provedor de e-mail e convites.
- Conectar Queue e processador completo dos eventos.
- Armazenar tokens por organização em solução criptografada/secret store adequada.
- Implementar envio Graph API e mídia com credenciais de teste.
- Executar testes A/B de isolamento e E2E em ambiente publicado.
- Concluir App Review/Business Verification e teste real de envio/recebimento.
- Revisão jurídica LGPD, política de retenção, termos e processo de titulares.
