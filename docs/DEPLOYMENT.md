# Implantação e integrações externas

## Cloudflare

1. Instale dependências com `pnpm install`.
2. Autentique o Wrangler e crie o banco: `pnpm wrangler d1 create av-flow-crm-db`.
3. Copie o `database_id` retornado para `wrangler.toml`.
4. Aplique: `pnpm db:migrate:remote`.
5. Cadastre segredos: `pnpm wrangler secret put SESSION_SECRET`, `META_APP_SECRET`, `META_VERIFY_TOKEN` e `ENCRYPTION_KEY`.
6. Configure o domínio customizado `avflowcrm.com.br` e confirme HTTPS, cookies, CSP e logs sem payloads sensíveis.
7. Confirme `APP_ORIGIN = "https://avflowcrm.com.br"`, execute `pnpm build` e `pnpm cf:deploy`. A origem também é usada na validação de requisições e nos links enviados por e-mail e ao checkout; após o deploy, acesse o app pelo domínio configurado, não pelo endereço antigo `workers.dev`.

Para desenvolvimento, copie `.dev.vars.example` para `.dev.vars` (arquivo ignorado) e use valores locais. Nunca commite segredos.

Mensagens rápidas compartilhadas exigem a migração `0019_quick_replies.sql` antes do deploy. Todos os membros ativos da empresa podem criar, editar, excluir e inserir essas mensagens no campo de texto das conversas; a seleção não envia automaticamente.

O processamento de áudio e imagem pela IA exige `0020_ai_media_processing.sql`. Ele fica desativado por padrão em cada organização e só transmite mídias recebidas à OpenAI quando um administrador ou gerente ativa a opção nas configurações do assistente. Áudios usam `OPENAI_TRANSCRIPTION_MODEL` (padrão `gpt-4o-mini-transcribe`); imagens usam `OPENAI_VISION_MODEL`, depois `OPENAI_MODEL` ou o modelo padrão, que precisa aceitar imagens. O processamento pode gerar custos de API.

A migração `0021_message_error_detail.sql` adiciona detalhes de erros da API da Meta às mensagens da caixa de entrada. Aplique as migrações pendentes antes de publicar o Worker.

A migração aditiva `0022_whatsapp_reliability.sql` registra origem, disponibilidade de conteúdo, referências de anúncios e chaves de idempotência, além de criar a fila D1 de respostas do Theo. Aplique-a antes de publicar o Worker. O cron de um minuto em `wrangler.toml` recupera jobs pendentes; confira os totais e falhas em **Configurações > WhatsApp**.

A migração aditiva `0023_ai_conversation_state.sql` separa o estado da IA (`IA_ATIVA`/`HUMANO`) e do catálogo (`PENDENTE`/`ENVIANDO`/`ENVIADO`/`FALHOU`). Aplique-a antes de publicar o Worker. Mensagens antigas sem job são recuperadas pelo cron somente quando têm conteúdo processável, ainda estão dentro da janela de atendimento e não possuem resposta anterior registrada.

## Assinaturas recorrentes — InfinitePay

1. No app InfinitePay, habilite as assinaturas/Planos e Recorrências e crie um plano mensal para cada faixa exibida em **Planos** (Essencial R$ 119, Pro R$ 149 e Scale R$ 249).
2. Configure os links públicos de inscrição nas vars `INFINITEPAY_ESSENCIAL_URL`, `INFINITEPAY_PRO_URL` e `INFINITEPAY_SCALE_URL` de `wrangler.toml`. Eles não são credenciais; segredos nunca devem ser colocados nessas vars.
3. Só links HTTPS de `infinitepay.io` são aceitos. A aba **Planos** habilita os botões à medida que cada link é configurado. O checkout e o recebimento acontecem na InfinitePay.
4. Antes de divulgar, confirme no painel que valores, periodicidade, meios de pagamento, parcelamento e renovação correspondem aos cards do CRM. Não envie links de inscrição de planos com preço diferente do exibido.

Esta integração usa os links recorrentes criados no painel, não a API de checkout de pagamento avulso. Os meios de pagamento disponíveis dependem das opções habilitadas para cada cobrança na InfinitePay. A confirmação, cancelamento e renovação da assinatura devem ser acompanhados no painel InfinitePay; o CRM não sincroniza eventos nem aplica limites por plano. Não anuncie ativação automática ou controle de acesso por assinatura até implementar e validar um mecanismo oficial de eventos/consulta para recorrências.

## Meta — checklist manual obrigatório

No Meta for Developers: crie um app do tipo apropriado ao caso vigente; adicione WhatsApp; configure empresa, domínio `avflowcrm.com.br` e a URL pública `https://avflowcrm.com.br/privacy.html`; registre a URL pública `https://avflowcrm.com.br/api/webhooks/meta`; use o mesmo verify token do secret; assine `messages` e `account_update`; configure o Embedded Signup v4; solicite permissões e acesso avançado exigidos pela documentação atual; conclua verificação empresarial e requisitos de Tech Provider quando aplicáveis. Confirme o novo domínio e a URL do webhook no painel antes de substituir qualquer configuração existente. Defina `META_APP_ID` e `META_CONFIG_ID` nas vars do Worker e `META_APP_SECRET` como secret. O fluxo troca o código de uso único no backend e guarda o token resultante criptografado com `ENCRYPTION_KEY`.

O Worker aceita `META_GRAPH_API_VERSION=v26.0` ou `v27.0`; sem a variável, continua usando v26.0. Não configure a variável em produção até concluir a validação e autorizar a migração. O changelog oficial da v27.0, lançada em 4 de novembro de 2026, não lista alterações nos endpoints de WhatsApp usados aqui; as mudanças publicadas tratam de Lead Ads, Pages e Marketing API. Isso não substitui testes na conta/app da Meta nem altera a versão do webhook. Embedded Signup, Graph API e a versão dos campos assinados no painel são configurações distintas.

O código atual envia texto, mídia e a mensagem interativa de encaminhamento para vendedor; não encontrei envio de templates aprovados nem mensagens de produto do catálogo da Meta. O catálogo do AV Flow é interno e suas fotos são enviadas como mídia. A alteração de Catalog Batch da Marketing API v27.0 não se aplica a esse fluxo.

Para oferecer coexistência com o WhatsApp Business App, use o `config_id` da configuração que a Meta forneceu com `featureType=whatsapp_business_app_onboarding`, `sessionInfoVersion=3` e Embedded Signup v4. O AV Flow usa `META_COEXISTENCE_CONFIG_ID` quando definido, ou `META_CONFIG_ID` como alternativa. No painel da Meta, assine os campos `messages`, `account_update`, `smb_message_echoes`, `history` e `smb_app_state_sync`; o Worker chama automaticamente `POST /{WABA_ID}/subscribed_apps` após conectar cada WABA e marca a integração com erro se a Meta não confirmar. A assinatura da conta não confirma que os campos estejam configurados no painel. Um administrador pode repetir a verificação em **Configurações > WhatsApp**; isso verifica a assinatura da WABA, não os campos do painel nem a entrega histórica. A mesma WABA não pode ser atribuída a outra organização; eventos de conta sem número que não possam ser associados de forma inequívoca são registrados como não correspondidos, sem serem enviados a múltiplos tenants.

O espelhamento de mensagens novas, edições e exclusões enviadas pelo WhatsApp Business usa `smb_message_echoes`; ecos são sempre outbound e nunca acionam o Theo. Edições e exclusões atualizam a mensagem original pela ID e falham explicitamente se ela não estiver no banco. Para importar o histórico, aplique também a migração `0010_whatsapp_history_sync.sql` e, em até 24 horas da conexão por coexistência, um administrador pode iniciar a solicitação na seção WhatsApp do CRM. A Meta aceita essa solicitação uma única vez; só a inicie depois de confirmar que o cliente autorizou o compartilhamento no WhatsApp Business App. O CRM processa mensagens históricas recebidas em `history` sem disparar respostas automáticas ou marcá-las como não lidas. Eventos `smb_app_state_sync` são aplicados à tabela auxiliar `whatsapp_business_app_contacts`, usando BSUID, telefone opcional e marcação de remoção sem apagar o registro; esses contatos sincronizados ainda não são leads nem conversas exibidas na caixa de entrada. Mensagens novas em que a Meta omite o telefone (`from`/`wa_id`) não podem ser associadas à caixa de entrada porque o modelo atual de conversas exige telefone; elas são registradas como falha, não convertidas em um telefone fictício. A Meta precisa aprovar a elegibilidade da plataforma/empresa; o link e a configuração, sozinhos, não concedem essa aprovação.

Webhooks com `type=unsupported` podem indicar tipo não suportado pela Cloud API (código 131051) ou mensagem indisponível para a API (131060), situação que a Meta documenta como comum na primeira mensagem a uma empresa em coexistência, inclusive em anúncios Click-to-WhatsApp. O CRM salva o evento e o código, mostra que o conteúdo não foi fornecido e não aciona o Theo sem conteúdo real. Não há API oficial para recuperar texto que a Meta omitiu; a mensagem deve ser consultada no WhatsApp Business. O timestamp recebido da mensagem ainda participa do cálculo de 24 horas; a Meta continua sendo a autoridade final ao aceitar ou recusar o envio. Mensagens com conteúdo de texto, referência de anúncio ou resposta `interactive.nfm_reply` são persistidas e podem iniciar o Theo; `flow_token` não é armazenado. Webhooks duplicados são deduplicados, e os jobs de IA são duráveis, tentados novamente com espera progressiva e protegidos por chave de idempotência. O evento não prova que o usuário viu ou enviou um texto que não esteja presente no payload.

Quando a conta retornada na coexistência contém vários números, o cliente seleciona o número no AV Flow. O token fica cifrado no servidor e a seleção fica válida por 15 minutos, vinculada à organização e ao usuário; registros expirados são excluídos pela rotina diária ou no próximo acesso da organização. A migração `0009_whatsapp_pending_signup.sql` é obrigatória antes do deploy. Eventos com falha retornam HTTP 500 para permitir reenvio pela Meta e são deduplicados por integração; as respostas do Theo também ficam em uma fila D1 para recuperação pelo cron, sem duplicar envios já aceitos. A retenção e o monitoramento dos jobs precisam ser revisados operacionalmente.

Para a classificação de pendência financeira e as ações de exclusão da caixa de entrada, aplique as migrações `0017_lead_financial_pending.sql` e `0018_deleted_whatsapp_messages.sql` antes do deploy. A exclusão remove mensagens ou conversas somente do AV Flow, não do WhatsApp do cliente; identificadores externos são mantidos para impedir a reimportação das mensagens excluídas. Excluir uma conversa também remove suas notas internas, mas não exclui o lead.

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
