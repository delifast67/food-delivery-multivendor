"""Recette navigateur du catalogue public, réseau externe interdit, aucune mutation."""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixture = json.loads(Path(fixture_path).read_text())
Path(result_path).parent.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []

def ok(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'])
    context = browser.new_context(viewport={'width': 390, 'height': 900}, service_workers='block')
    external, errors, requests = [], [], []
    def guard(route):
        if route.request.url.startswith(base + '/') or route.request.url.startswith(('data:', 'blob:')):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    def track(route):
        body = json.loads(route.request.post_data or '{}')
        query = body.get('query', '')
        requests.append(body)
        assert not re.search(r'\bmutation\b', query), 'Mutation interdite'
        assert not re.search(r'\brestaurants\s*\{', query), 'Catalogue legacy interdit'
        response = route.fetch()
        payload = response.json()
        assert not payload.get('errors'), payload
        if 'publicRestaurantPage' in query:
            assert 'limit: 20' in query and not re.search(r'\b(menu|categories)\s*\{', query)
            rows = payload['data']['publicRestaurantPage']['items']
            assert len(rows) <= 20
            assert all(set(row) == {'id', 'name', 'description', 'open', 'version'} for row in rows)
        elif 'publicMenuCategoryPage' in query:
            assert 'limit: 20' in query
            assert len(payload['data']['publicMenuCategoryPage']['items']) <= 20
        elif 'publicMenuPage' in query:
            assert 'limit: 20' in query and 'optionGroups' in query
            assert sum(len(s['items']) for s in payload['data']['publicMenuPage']['sections']) <= 20
        elif re.search(r'\brestaurant\s*\(', query):
            assert not re.search(r'\b(menu|categories)\s*\{', query)
        else:
            assert 'calculateCheckout' in query, query
        route.fulfill(response=response)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/delifast/graphql', track)
    page.goto(base + '/delifast')
    cards = page.locator('.df-restaurants .df-card')
    expect(cards).to_have_count(20)
    for count in [40, 60, 65]:
        page.get_by_role('button', name='Charger plus de restaurants').click()
        expect(cards).to_have_count(count)
    assert len(set(cards.locator('h3').all_text_contents())) == 65
    expect(page.get_by_role('button', name='Charger plus de restaurants')).to_have_count(0)
    ok('65 restaurants accessibles par pages de 20, sans menus imbriqués ni doublons')

    page.get_by_label('Rechercher un restaurant').fill('Restaurant Public 064')
    expect(cards).to_have_count(1)
    expect(cards.locator('h3')).to_have_text('Restaurant Public 064')
    page.get_by_role('button', name='Voir le menu').click()
    expect(page.get_by_role('heading', name='Restaurant Public 064', level=2)).to_be_visible()
    menu_items = page.locator('.df-menu .df-item')
    expect(menu_items).to_have_count(20)
    ok('recherche serveur d’un restaurant hors première page et ouverture du menu')

    select = page.get_by_label('Catégorie', exact=True)
    expect(select.locator('option')).to_have_count(22)
    page.get_by_role('button', name='Charger plus de catégories').click()
    expect(select.locator('option')).to_have_count(42)
    expect(page.get_by_role('button', name='Charger plus de catégories')).to_have_count(0)
    assert len(set(select.locator('option').evaluate_all('(options) => options.map(o => o.value)'))) == 42
    ok('40 catégories actives sur deux pages, archives exclues et Autres accessible')

    for count in [40, 60, 61]:
        page.get_by_role('button', name='Charger plus de plats').click()
        expect(menu_items).to_have_count(count)
    assert len(set(menu_items.locator('strong').all_text_contents())) == 61
    expect(page.get_by_role('button', name='Ajouter Plat public 008')).to_be_disabled()
    ok('61 plats non archivés par pages de 20, plats indisponibles visibles et désactivés')

    search = page.get_by_label('Rechercher un plat')
    search.fill('Plat public 061')
    expect(menu_items).to_have_count(1)
    expect(menu_items.locator('strong')).to_have_text('Plat public 061')
    ok('recherche serveur d’un plat hors première page')
    search.fill('')
    expect(menu_items).to_have_count(20)
    select.select_option('public-cat-001')
    expect(menu_items).to_have_count(2)
    assert any(r.get('variables', {}).get('categoryId') == 'public-cat-001' for r in requests if 'publicMenuPage' in r['query'])
    ok('filtre catégorie transmis au serveur')
    select.select_option('__uncategorized')
    expect(page.get_by_role('heading', name='Sans catégorie', exact=True)).to_be_visible()
    assert all(text == 'Sans catégorie' for text in page.locator('.df-category h4').all_text_contents())
    ok('Autres inclut les plats sans catégorie active')
    select.select_option('')
    expect(menu_items).to_have_count(20)

    page.get_by_role('button', name='Configurer Plat public 001', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog).to_be_visible()
    dialog.get_by_role('radio', name=re.compile('Riz parfumé')).check()
    dialog.get_by_role('button', name='Ajouter au panier', exact=True).click()
    cart = page.locator('.df-cart-lines')
    expect(cart.get_by_text('Plat public 001', exact=True)).to_be_visible()
    expect(cart.get_by_text(re.compile('Options : Riz parfumé'))).to_be_visible()
    expect(page.get_by_text('Total serveur', exact=True)).to_be_visible()
    select.select_option('__uncategorized')
    expect(page.get_by_role('heading', name='Sans catégorie', exact=True)).to_be_visible()
    expect(cart.get_by_text('Plat public 001', exact=True)).to_be_visible()
    expect(cart.get_by_text(re.compile('Options : Riz parfumé'))).to_be_visible()
    ok('configurateur, prix serveur et panier/options préservés hors filtre courant')

    dimensions = page.evaluate('({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})')
    assert dimensions['width'] == 390 and dimensions['scrollWidth'] <= 390, dimensions
    assert not external, external
    assert not errors, errors
    ok('390 px sans débordement, aucune erreur JavaScript ni requête extérieure')
    Path(result_path).write_text(json.dumps({
        'restaurantId': fixture['rid'], 'checks': checks, 'requests': len(requests),
        'dimensions': dimensions, 'externalRequests': external, 'javascriptErrors': errors,
    }, ensure_ascii=False, indent=2) + '\n')
    browser.close()
