import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Real route and call analysis; Python fixture text is never executed. */
export async function checkPythonFeatureFlow(app, page, folder) {
  const sources = {
    'manage.py': '',
    'foreign/__init__.py': '',
    'foreign/application.py': 'from fastapi import FastAPI\nfrom flask import Flask\napi = FastAPI()\nweb = Flask(__name__)\n',
    'foreign/direct.py': '# 가져온 앱 😀\nfrom .application import api\n@api.get("/imported-fast")\ndef imported_fast():\n    return []\n',
    'foreign/module.py': 'from . import application\n@application.web.route("/imported-flask")\ndef imported_flask():\n    return []\n',
    'foreign/routers.py': 'from fastapi import APIRouter\nfrom flask import Blueprint\nrouter = APIRouter(prefix="/v4")\nbp = Blueprint("entries", __name__, url_prefix="/old")\n@router.get("/entries")\ndef router_entries():\n    return []\n@bp.get("/entries")\ndef blueprint_entries():\n    return []\n',
    'foreign/registration.py': 'from fastapi import FastAPI\nfrom flask import Flask\nfrom .routers import router, bp\napi = FastAPI()\nweb = Flask(__name__)\napi.include_router(router, prefix="/external")\nweb.register_blueprint(bp, url_prefix="/blue")\n',
    'foreign/decorated_router.py': 'from .routers import router\n@router.get("/foreign-handlers")\ndef imported_router_handler():\n    return []\n',
    'foreign/factory.py': 'from flask import Flask\nfrom .routers import bp\ndef create_web():\n    app = Flask(__name__)\n    app.register_blueprint(bp, url_prefix="/factory-blue")\n    return app\n',
    'modulefactory.py': 'from fastapi import FastAPI, APIRouter\nmodule_router = APIRouter(prefix="/v5")\n@module_router.get("/records")\ndef module_records():\n    return []\ndef create_app():\n    app = FastAPI()\n    app.include_router(module_router, prefix="/factory-module")\n    return app\n',
    'flaskrules.py': 'from flask import Flask\napp = Flask(__name__)\ndef rule_users():\n    return []\napp.add_url_rule("/direct-rules", view_func=rule_users, methods=["GET"])\n',
    'site/__init__.py': '',
    'site/settings.py': 'ROOT_URLCONF = "site.urls"\n',
    'site/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("users/", views.handle)]\n',
    'site/views.py': '# 한국어 😀\ndef handle(request):\n    return helper(1)\ndef helper(value):\n    return value\n',
    'factory.py': 'from fastapi import FastAPI\ndef factory_helper(value):\n    return value\ndef create_app():\n    app = FastAPI()\n    @app.get("/factory/{id}")\n    def factory_handler(id):\n        return factory_helper(id)\n    return app\n',
    'registrations.py': 'from fastapi import FastAPI, APIRouter\nfrom flask import Flask, Blueprint\napi = FastAPI()\nrouter = APIRouter(prefix="/v1")\n@router.get("/widgets")\ndef api_widgets():\n    return []\napi.include_router(router, prefix="/api")\nweb = Flask(__name__)\nbp = Blueprint("widgets", __name__, url_prefix="/old")\n@bp.get("/widgets")\ndef flask_widgets():\n    return []\nweb.register_blueprint(bp, url_prefix="/bp")\n',
    'factoryrouters.py': "from fastapi import FastAPI, APIRouter\nfrom flask import Flask, Blueprint\ndef create_api():\n    app = FastAPI()\n    router = APIRouter(prefix=\"/v2\")\n    @router.get(\"/books\")\n    def factory_books():\n        return []\n    app.include_router(router, prefix=\"/app\")\n    return app\ndef create_web():\n    app = Flask(__name__)\n    bp = Blueprint(\"pages\", __name__, url_prefix=\"/old\")\n    @bp.get(\"/pages\")\n    def factory_pages():\n        return []\n    app.register_blueprint(bp, url_prefix=\"/shelf\")\n    return app\n",
    'nested.py': "from fastapi import FastAPI, APIRouter\napp = FastAPI()\nouter = APIRouter(prefix=\"/nested\")\ninner = APIRouter(prefix=\"/v3\")\n@inner.get(\"/chapters\")\ndef nested_chapters():\n    return []\nouter.include_router(inner, prefix=\"/group\")\napp.include_router(outer, prefix=\"/api\")\n",
    'nestedflask.py': "from flask import Flask, Blueprint\napp = Flask(__name__)\nparent = Blueprint(\"parent\", __name__, url_prefix=\"/library\")\nchild = Blueprint(\"child\", __name__, url_prefix=\"/old\")\n@child.get(\"/notes\")\ndef nested_notes():\n    return []\nparent.register_blueprint(child, url_prefix=\"/pages\")\napp.register_blueprint(parent)\n",
    'mounted.py': "from fastapi import FastAPI\napp = FastAPI()\nchild = FastAPI()\n@child.get(\"/items\")\ndef mounted_items():\n    return []\napp.mount(\"/mounted\", child)\n",
    'client.ts': 'export function load() { return fetch("/users/"); }\nexport function factoryLoad() { return fetch("/factory/1"); }\nexport function apiWidgets() { return fetch("/api/v1/widgets"); }\nexport function flaskWidgets() { return fetch("/bp/widgets"); }\nexport function books() { return fetch("/app/v2/books"); }\nexport function pages() { return fetch("/shelf/pages"); }\nexport function chapters() { return fetch("/api/nested/group/v3/chapters"); }\nexport function notes() { return fetch("/library/pages/notes"); }\nexport function mountedItems() { return fetch("/mounted/items"); }\n',
  };
  sources['client.ts'] += 'export function importedFast() { return fetch("/imported-fast"); }\nexport function importedFlask() { return fetch("/imported-flask"); }\n';
  sources['client.ts'] += 'export function routerEntries() { return fetch("/external/v4/entries"); }\nexport function blueprintEntries() { return fetch("/blue/entries"); }\nexport function importedRouterHandler() { return fetch("/external/v4/foreign-handlers"); }\n';
  sources['client.ts'] += 'export function moduleRecords() { return fetch("/factory-module/v5/records"); }\nexport function factoryBlueprintEntries() { return fetch("/factory-blue/entries"); }\n';
  sources['client.ts'] += 'export function directRules() { return fetch("/direct-rules"); }\n';
  for (const [name, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), source);
  }
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    globalThis.restorePythonFlowDialog = () => { dialog.showOpenDialog = original; delete globalThis.restorePythonFlowDialog; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  try {
    await page.getByRole('button', { name: '프로젝트 폴더 열기', exact: true }).click();
    await page.getByRole('heading', { name: path.basename(folder), exact: true }).waitFor();
    await page.getByRole('button', { name: '한눈에 보기', exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
    const list = page.getByRole('region', { name: '기능 목록', exact: true });
    await list.getByRole('heading', { name: '기능 고르기', exact: true }).waitFor();
    const server = list.locator('details').filter({ has: page.locator('summary', { hasText: /^서버 주소 기준 목록 \(AI 정리 포함\)$/ }) });
    await list.getByRole('status').filter({ hasText: '화면별로 묶는 중' }).waitFor({ state: 'detached', timeout: 30_000 });
    if (await server.count() && !await server.evaluate(element => element.open)) await server.locator(':scope > summary').click();
    await list.getByRole('listitem')
      .filter({ hasText: '받기 · /users/' }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^전체 그림과 단계 보기$/ }) });
    await details.waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    const diagram = page.getByTestId('feature-flow-canvas');
    await diagram.getByRole('group', { name: 'site/views.py · handle', exact: true }).waitFor();
    await diagram.getByRole('group', { name: 'site/views.py · helper', exact: true }).waitFor();
    const steps = page.getByRole('region', { name: '기능 흐름 단계', exact: true }).getByTestId('feature-step');
    const handler = steps.filter({ has: page.locator('b', { hasText: /^handle$/ }) });
    await handler.getByText('추정', { exact: true }).waitFor();
    await handler.getByText('같은 파일의 함수 선언 후보예요. 함수나 모듈이 다른 코드로 전달되어 실제 호출 대상은 확정하지 못했어요.', { exact: false }).waitFor();
    const step = steps
      .filter({ has: page.locator('b', { hasText: /^helper$/ }) });
    await step.getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: site/views.py · 4–5줄', { exact: true }).waitFor();
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await step.getByRole('button', { name: '이 함수 흐름', exact: true }).click();
    await page.getByRole('heading', { name: '함수 안 순서', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '함수와 단계', exact: true }).getByRole('button', { name: 'helper', exact: true })
      .and(page.locator('[aria-pressed="true"]')).waitFor();
    assert.equal(await page.getByRole('list', { name: '이 함수를 부르는 곳', exact: true }).count(), 0);
    await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
    await page.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
    await list.getByRole('listitem').filter({ hasText: '보기 · /factory/{id}' })
      .getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
    await details.waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    await diagram.getByRole('group', { name: 'factory.py · factory_handler', exact: true }).waitFor();
    await diagram.getByRole('group', { name: 'factory.py · factory_helper', exact: true }).waitFor();
    await steps.filter({ has: page.locator('b', { hasText: /^GET \/factory\/1$/ }) }).getByText('추정', { exact: true }).waitFor();
    await page.getByRole('region', { name: '기능 흐름 단계', exact: true })
      .getByText('factory.py: 앱 팩토리 안에서 찾은 주소는 실행·배포 여부를 확인하지 않아 추정으로 표시해요.', { exact: true }).waitFor();
    await steps.filter({ has: page.locator('b', { hasText: /^factory_handler$/ }) }).getByRole('button', { name: '코드 보기', exact: true }).click();
    await page.getByTestId('evidence-range').getByText('근거: factory.py · 6–8줄', { exact: true }).waitFor();
    for (const [route, name, lines, file, uncertain] of [
      ['/api/v1/widgets', 'api_widgets', '5–7', 'registrations.py', false], ['/bp/widgets', 'flask_widgets', '11–13', 'registrations.py', false],
      ['/api/nested/group/v3/chapters', 'nested_chapters', '5–7', 'nested.py', false],
      ['/library/pages/notes', 'nested_notes', '5–7', 'nestedflask.py', false],
      ['/mounted/items', 'mounted_items', '4–6', 'mounted.py', true],
      ['/imported-fast', 'imported_fast', '3–5', 'foreign/direct.py', true],
      ['/imported-flask', 'imported_flask', '2–4', 'foreign/module.py', true],
      ['/external/v4/entries', 'router_entries', '5–7', 'foreign/routers.py', true],
      ['/blue/entries', 'blueprint_entries', '8–10', 'foreign/routers.py', true],
      ['/external/v4/foreign-handlers', 'imported_router_handler', '2–4', 'foreign/decorated_router.py', true],
      ['/factory-module/v5/records', 'module_records', '3–5', 'modulefactory.py', true],
      ['/factory-blue/entries', 'blueprint_entries', '8–10', 'foreign/routers.py', true],
      ['/direct-rules', 'rule_users', '3–4', 'flaskrules.py', true],
      ['/app/v2/books', 'factory_books', '6–8', 'factoryrouters.py', true], ['/shelf/pages', 'factory_pages', '14–16', 'factoryrouters.py', true],
    ]) {
      await page.getByRole('button', { name: '흐름 따라가기', exact: true }).click();
      await page.getByRole('button', { name: '다른 기능 고르기', exact: true }).click();
      await list.getByRole('listitem').filter({ hasText: `보기 · ${route}` }).getByRole('button', { name: '이 기능 따라가기', exact: true }).click();
      await details.waitFor();
      if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
      await diagram.getByRole('group', { name: `${file} · ${name}`, exact: true }).waitFor();
      const request = steps.filter({ has: page.locator('b', { hasText: `GET ${route}` }) });
      await request.waitFor();
      if (uncertain) await request.getByText('추정', { exact: true }).waitFor();
      assert.equal(await request.getByText('추정', { exact: true }).count(), uncertain ? 1 : 0);
      await steps.filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) })
        .getByRole('button', { name: '코드 보기', exact: true }).click();
      await page.getByTestId('evidence-range').getByText(`근거: ${file} · ${lines}줄`, { exact: true }).waitFor();
    }
    for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(path.join(folder, name), 'utf8'), source);
  } finally {
    await app.evaluate(() => globalThis.restorePythonFlowDialog?.());
  }
}
