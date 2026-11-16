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

## Assinaturas recorrentes — InfinitePay

1. No app InfinitePay, habilite as assinaturas/Planos e Recorrências e crie um plano mensal para cada faixa exibida em **Planos** (Essencial R$ 119, Pro R$ 149 e Scale R$ 249).
2. Configure os links públicos de inscrição nas vars `INFINITEPAY_ESSENCIAL_URL`, `INFINITEPAY_PRO_URL` e `INFINITEPAY_SCALE_URL` de `wrangler.toml`. Eles não são credenciais; segredos nunca devem ser colocados nessas vars.
3. Só links HTTPS de `infinitepay.io` são aceitos. A aba **Planos** habilita os botões à medida que cada link é configurado. O checkout e o recebimento acontecem na InfinitePay.
4. Antes de divulgar, confirme no painel que valores, periodicidade, meios de pagamento, parcelamento e renovação correspondem aos cards do CRM. Não envie links de inscrição de planos com preço diferente do exibido.

Esta integração usa os links recorrentes criados no painel, não a API de checkout de pagamento avulso. Os meios de pagamento disponíveis dependem das opções habilitadas para cada cobrança na InfinitePay. A confirmação, cancelamento e renovação da assinatura devem ser acompanhados no painel InfinitePay; o CRM não sincroniza eventos nem aplica limites por plano. Não anuncie ativação automática ou controle de acesso por assinatura até implementar e validar um mecanismo oficial de eventos/consulta para recorrências.

## Meta — checklist manual obrigatório

No Meta for Developers: crie um app do tipo apropriado ao caso vigente; adicione WhatsApp; configure empresa, domínios e a URL pública `https://leadflowcrmsaas.contato-167.workers.dev/privacy.html`; registre a URL pública `/api/webhooks/meta`; use o mesmo verify token do secret; assine `messages` e `account_update`; configure o Embedded Signup v4; solicite permissões e acesso avançado exigidos pela documentação atual; conclua verificação empresarial e requisitos de Tech Provider quando aplicáveis. Defina `META_APP_ID` e `META_CONFIG_ID` nas vars do Worker e `META_APP_SECRET` como secret. O fluxo troca o código de uso único no backend e guarda o token resultante criptografado com `ENCRYPTION_KEY`.

Para oferecer coexistência com o WhatsApp Business App, use o `config_id` da configuração que a Meta forneceu com `featureType=whatsapp_business_app_onboarding`, `sessionInfoVersion=3` e Embedded Signup v4. O AV Flow usa `META_COEXISTENCE_CONFIG_ID` quando definido, ou `META_CONFIG_ID` como alternativa. No painel da Meta, assine os campos `messages`, `account_update`, `smb_message_echoes`, `history` e `smb_app_state_sync`; o Worker assina a conta de mensagens de cada cliente em `subscribed_apps`. A assinatura da conta não confirma que os campos estejam configurados no painel.

O espelhamento de mensagens novas usa `smb_message_echoes`, mas edição e exclusão de mensagens, importação de histórico e sincronização de contatos ainda não são suportadas. Os eventos `history` e `smb_app_state_sync` recebidos são registrados como falhos, sem seus dados pessoais; não execute as chamadas `smb_app_data` até implementar e validar o processamento, pois a Meta informa que cada sincronização só pode ser solicitada uma vez e deve ser iniciada em até 24 horas após o onboarding. A Meta precisa aprovar a elegibilidade da plataforma/empresa; o link e a configuração, sozinhos, não concedem essa aprovação.

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

## Confirmação de e-mail

O cadastro envia um link de confirmação (válido por 24 h) pela API da Resend. A exigência só vale quando os dois itens abaixo estão configurados; sem eles, o cadastro entra direto, como antes.

1. Crie uma conta em resend.com e verifique um domínio seu (o `workers.dev` não envia e-mail).
2. Defina o remetente em `wrangler.toml` → `[vars]` → `EMAIL_FROM = "AV Flow CRM <no-reply@seudominio.com>"` e a chave com `pnpm exec wrangler secret put RESEND_API_KEY`.
3. Faça o deploy. Contas existentes e convidados contam como verificados; contas novas não confirmadas em 3 dias são removidas pela limpeza diária.

## Limpeza de contas inativas

Uma tarefa diária (cron `0 6 * * *`, definida em `wrangler.toml`) remove contas abandonadas: empresa criada há mais de 14 dias, com um único usuário, sem leads, contatos, conversas, vendas ou integrações e sem acesso nos últimos 14 dias. Contas com qualquer uso, e superadmins, nunca são removidas. Ajuste `INACTIVE_DAYS` em `worker/cleanup.ts` se quiser outro prazo. Atualize a política de retenção/privacidade para mencionar essa regra.

## Pendências antes de produção

- Provisionar D1 e aplicar migração.
- Implementar recuperação de senha por provedor de e-mail e convites.
- Conectar Queue e processador completo dos eventos.
- Armazenar tokens por organização em solução criptografada/secret store adequada.
- Implementar envio Graph API e mídia com credenciais de teste.
- Executar testes A/B de isolamento e E2E em ambiente publicado.
- Concluir App Review/Business Verification e teste real de envio/recebimento.
- Revisão jurídica LGPD, política de retenção, termos e processo de titulares.
