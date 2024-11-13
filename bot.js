const { chromium } = require('playwright');
const fs = require('fs');
const cheerio = require('cheerio');
const persist = require('node-persist');
const sqlite3 = require('sqlite3').verbose();

// Inicializar persistência de cookies
(async () => {
    await persist.init({
        dir: 'cookie_storage',
        stringify: JSON.stringify,
        parse: JSON.parse,
        encoding: 'utf8',
        ttl: false
    });
})();

// Função para salvar cookies em um arquivo JSON
async function saveCookies(page) {
    const cookies = await page.context().cookies();
    await persist.setItem('cookies', cookies);
    console.log('Cookies salvos em cookie_storage');
}

// Função para restaurar cookies a partir de node-persist
async function restoreCookies(page) {
    const cookies = await persist.getItem('cookies');
    if (cookies) {
        await page.context().addCookies(cookies);
        console.log('Cookies restaurados de cookie_storage');
    } else {
        console.log('Nenhum cookie encontrado, login será necessário.');
    }
}

// Função para limpar a tabela do banco de dados antes de começar a exportação de novos dados
function clearTable() {
    const db = new sqlite3.Database('processos.db');
    db.serialize(() => {
        db.run(`DELETE FROM processos`, (err) => {
            if (err) {
                console.error('Erro ao limpar a tabela:', err);
            } else {
                console.log('Tabela limpa com sucesso.');
            }
        });
    });
    db.close();
}

// Função para extrair dados da tabela no iframe
async function extractDataFromIframeTable(page) {
    try {
        const iframeHandle = await page.waitForSelector('//*[@id="ifrVisualizacao"]', { timeout: 2000 });
        const iframe = await iframeHandle.contentFrame();
        const isTablePresent = await iframe.$('//*[@id="tblHistorico"]');

        if (!isTablePresent) {
            console.log('Tabela de histórico não encontrada.');
            return [];
        }

        const tableHTML = await iframe.$eval('//*[@id="tblHistorico"]', el => el.outerHTML);
        const $ = cheerio.load(tableHTML);
        const secondRow = $('tbody tr:nth-child(2)');
        const rowData = [];

        secondRow.find('td').each((index, element) => {
            rowData.push($(element).text().trim());
        });

        console.table(rowData);

        return rowData;
    } catch (error) {
        console.error('Erro ao extrair dados da tabela:', error);
        return [];
    }
}

// Função para exportar os dados para o banco SQLite3
function exportToSQLite(rowData) {
    const db = new sqlite3.Database('processos.db');

    db.serialize(() => {
        // Criar a tabela principal 'processos' se não existir
        db.run(`CREATE TABLE IF NOT EXISTS processos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_processo TEXT,
            descricao TEXT,
            data_recebimento TEXT,
            unidade TEXT,
            usuario TEXT,
            detalhes TEXT,
            quantidade_dias INTEGER
        )`, (err) => {
            if (err) {
                console.error('Erro ao criar a tabela processos:', err);
                return;
            }
            console.log('Tabela processos criada ou já existe.');
        });

        // Criar a tabela temporária 'processos_temp' como uma tabela normal, se não existir
        db.run(`CREATE TABLE IF NOT EXISTS processos_temp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_processo TEXT,
            descricao TEXT,
            data_recebimento TEXT,
            unidade TEXT,
            usuario TEXT,
            detalhes TEXT,
            quantidade_dias INTEGER
        )`, (err) => {
            if (err) {
                console.error('Erro ao criar a tabela processos_temp:', err);
                return;
            }
            console.log('Tabela processos_temp criada ou já existe.');
        });

        // Preparar e inserir os dados na tabela temporária
        const stmt = db.prepare(`INSERT INTO processos_temp 
            (nome_processo, descricao, data_recebimento, unidade, usuario, detalhes, quantidade_dias) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`);

        stmt.run(rowData[0], rowData[1], rowData[2], rowData[3], rowData[4], rowData[5], rowData[6]);

        stmt.finalize();
        console.log('Dados exportados para a tabela processos_temp.');

        // Após o fim do scraping, fazer o swap dos dados para a tabela principal
        db.run(`INSERT INTO processos (nome_processo, descricao, data_recebimento, unidade, usuario, detalhes, quantidade_dias)
                SELECT nome_processo, descricao, data_recebimento, unidade, usuario, detalhes, quantidade_dias
                FROM processos_temp`, (err) => {
            if (err) {
                console.error('Erro ao inserir dados da tabela temporária para a tabela principal:', err);
                return;
            }
            console.log('Dados movidos com sucesso da tabela temporária para a tabela principal.');
        });

        // Apagar a tabela temporária após o swap
        db.run('DROP TABLE IF EXISTS processos_temp', (err) => {
            if (err) {
                console.error('Erro ao apagar a tabela temporária:', err);
                return;
            }
            console.log('Tabela temporária apagada com sucesso.');
        });
    });

    db.close();
}


// Script principal
(async () => {
    clearTable(); // Limpar a tabela antes de começar a exportar dados

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        ignoreDefaultArgs: ['--disable-extensions'],
        bypassCSP: true,
        acceptDownloads: true,
        noCache: true,
    });
    const page = await context.newPage();

    await restoreCookies(page);
    await page.goto('https://sip.pi.gov.br/sip/login.php?sigla_orgao_sistema=GOV-PI&sigla_sistema=SEI&infra_url=L3NlaS8=', { waitUntil: 'networkidle' });

    // Verifique se o login foi realizado corretamente
    if (await page.isVisible('//*[@id="sbmLogin"]')) {
        console.log('Login necessário.');
        await page.locator('//*[@id="txtUsuario"]').fill('automacaosei@saude.pi.gov.br');
        await page.locator('//*[@id="pwdSenha"]').fill('autoSEI2024');
        await page.locator('//*[@id="selOrgao"]').selectOption({ label: 'SESAPI-PI' });
        await page.locator('//*[@id="sbmLogin"]').click();
        await saveCookies(page);
    } else {
        console.log('Usuário já está logado.');
    }

    // Aguarde o carregamento da página
    try {
        await page.waitForSelector('//*[@id="selInfraUnidades"]', { timeout: 5000 });
        console.log('Página carregada com sucesso.');
    } catch (error) {
        console.error('Erro ao carregar a página ou elemento não encontrado:', error);
        await browser.close();
        return;
    }

    const options = await page.$$eval('#selInfraUnidades option', (options) => options.map((option, index) => ({
        value: option.value,
        index: index + 1
    })));

    for (const { value: optionValue, index } of options) {
        // Pular a opção específica (48)
        if (index === 48) {
            console.log('Pular a option 48.');
            continue; // Isso deve funcionar corretamente aqui dentro
        }
    
        console.log(`Selecionando a unidade: ${optionValue} (Index: ${index})`);
        await page.locator('//*[@id="selInfraUnidades"]').selectOption(optionValue);
    

        try {
            await page.waitForSelector('#tblProcessosRecebidos', { timeout: 2000 });
        } catch {
            console.log(`Nenhuma tabela encontrada para a unidade: ${optionValue}. Prosseguindo para o próximo setor.`);
            continue;
        }

        let hasNextPage = true;
        const tabelaURL = page.url();

        while (hasNextPage) {
            const rows = await page.$$eval('#tblProcessosRecebidos tbody tr', rows => {
                return rows.map(row => {
                    const thirdTd = row.querySelectorAll('td')[2];
                    const linkElement = thirdTd ? thirdTd.querySelector('a') : null;
                    return linkElement ? {
                        href: linkElement.href,
                        linkName: linkElement.textContent.trim(),
                        tooltip: linkElement.getAttribute('onmouseover') || ''
                    } : null;
                }).filter(link => link !== null);
            });

            if (rows.length === 0) {
                console.log('Nenhum link encontrado na tabela. Prosseguindo para o próximo setor...');
                break;
            }

            for (const { href, linkName, tooltip } of rows) {
                console.log(`Clicando no link: ${href}`);
                let attempts = 0;
                const maxAttempts = 3;

                while (attempts < maxAttempts) {
                    try {
                        await page.goto(href, { waitUntil: 'networkidle' });
                        break;
                    } catch (error) {
                        attempts++;
                        console.error(`Tentativa ${attempts} ao acessar ${href} falhou. Retentando...`);
                        await page.waitForTimeout(1000);
                    }
                }

                if (attempts === maxAttempts) {
                    console.error(`Falha ao acessar ${href} após ${maxAttempts} tentativas.`);
                    continue;
                }

                const iframeHandle = await page.waitForSelector('//*[@id="ifrArvore"]', { timeout: 2000 });
                const iframe = await iframeHandle.contentFrame();
                await iframe.waitForSelector('//*[@id="divConsultarAndamento"]/a', { timeout: 2000 });
                await iframe.click('//*[@id="divConsultarAndamento"]/a');
                console.log("Botão 'Consultar Andamento' clicado!");

                await page.waitForTimeout(2000);

                const rowData = await extractDataFromIframeTable(page);
                let tooltipText = '';

                if (tooltip) {
                    const matches = tooltip.match(/'([^']*)'|(\w+[^,]*)$/g);
                    if (matches) {
                        tooltipText = matches.pop().replace(/'/g, '').trim();
                    }
                }

                const exportData = [linkName, tooltipText, ...rowData];
                console.table(exportData);

                // Salvar dados no SQLite
                exportToSQLite(exportData);
            }

            hasNextPage = await page.isVisible('//*[@id="pagingNext"]');
            if (hasNextPage) {
                await page.locator('//*[@id="pagingNext"]').click();
            }
        }
    }

    await browser.close();
})();
