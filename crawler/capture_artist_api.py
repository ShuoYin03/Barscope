"""
在浏览器里登录网易云 → 访问歌手页 → 按 Enter → 输出捕获结果
"""
from playwright.sync_api import sync_playwright
import json

results = []

def find_bg(obj, path=''):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if 'background' in k.lower():
                print(f'  FIELD {path}.{k} = {str(v)[:200]}')
            find_bg(v, path + '.' + k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:5]):
            find_bg(v, path + f'[{i}]')

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=False,
        args=['--disable-blink-features=AutomationControlled']
    )
    context = browser.new_context(
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    )
    context.add_init_script(
        'Object.defineProperty(navigator, "webdriver", {get: () => undefined})'
    )
    page = context.new_page()

    def on_response(response):
        url = response.url
        if 'music.163.com' in url:
            try:
                body = response.json()
                text = json.dumps(body, ensure_ascii=False)
                if 'background' in text.lower():
                    results.append({'url': url, 'body': body})
                    print(f'[HIT] {url}')
                    find_bg(body)
            except:
                pass

    page.on('response', on_response)
    page.goto('https://music.163.com/', timeout=20000, wait_until='domcontentloaded')

    print('\n请在浏览器里登录，然后访问 GAI 歌手页：')
    print('  https://music.163.com/#/artist?id=1211046')
    print('\n等页面加载完后，回到这里按 Enter ...')
    input()

    page.wait_for_timeout(2000)
    browser.close()

print(f'\n共捕获 {len(results)} 个含 background 字段的响应')
with open('artist_api_capture.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print('详情已写入 artist_api_capture.json')
