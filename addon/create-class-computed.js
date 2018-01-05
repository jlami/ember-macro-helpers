import Ember from 'ember';
import EmberObject, {
  computed,
  observer,
  get,
  setProperties,
  defineProperty
} from '@ember/object';
import Component from '@ember/component';
import { on } from '@ember/object/evented';
import { once } from '@ember/runloop';
// import { getOwner } from '@ember/application';
import getValue from './get-value';
import { collapseKeysWithMap } from './collapse-keys';
import flattenKeys from './flatten-keys';
import {
  ARRAY_EACH,
  ARRAY_LENGTH
} from './-constants';

const {
  WeakMap,
  meta
} = Ember;

const PROPERTIES = new WeakMap();

function findOrCreatePropertyInstance(context, propertyClass, key, cp) {
  let propertiesForContext = PROPERTIES.get(context);
  if (!propertiesForContext) {
    propertiesForContext = new WeakMap();
    PROPERTIES.set(context, propertiesForContext);
  }

  let property = propertiesForContext.get(cp);
  if (property) {
    return property;
  }

  // let owner = getOwner(context);
  property = propertyClass.create(/* owner.ownerInjection(), */{
    key,
    context,
    nonStrings: EmberObject.create()
  });

  propertiesForContext.set(cp, property);

  if (context instanceof Component) {
    context.one('willDestroyElement', () => {
      property.destroy();
    });
  }

  return property;
}

const BaseClass = EmberObject.extend({
  computedDidChange: observer('computed', function() {
    let { context, key } = this;

    if (context.isDestroying) {
      // controllers can get into this state
      this.destroy();

      return;
    }

    // try our best to detect and prevent a double render
    let _meta = meta(context);
    // no longer needed in ember 2.12
    if (_meta.readableLastRendered) {
      let lastRendered = _meta.readableLastRendered();
      if (lastRendered && Object.hasOwnProperty.call(lastRendered, key)) {
        return;
      }
    }

    context.notifyPropertyChange(key);
  })
});

function resolveMappedLocation(key, i) {
  if (typeof key === 'string') {
    return `context.${key}`;
  } else {
    return `nonStrings.${i}`;
  }
}

export default function(observerBools, macroGenerator) {
  return function(...keys) {
    let { collapsedKeys, keyMap } = collapseKeysWithMap(keys);

    function getOriginalArrayDecorator(key, i) {
      if (typeof key === 'string') {
        let originalKey = keys[keyMap[i]];
        if (originalKey.indexOf(ARRAY_EACH) !== -1 || originalKey.indexOf(ARRAY_LENGTH) !== -1) {
          return originalKey;
        }
      }
      return key;
    }

    let mappedKeys = [];

    function rewriteComputed(obj, key) {
      let mappedWithResolvedOberverKeys = mappedKeys.map((macro, i) => {
        let shouldObserve = observerBools[i];
        if (shouldObserve) {
          macro = getValue({ context: this, macro, key });
        }
        return macro;
      });

      let cp = macroGenerator.apply(this, mappedWithResolvedOberverKeys);
      defineProperty(this, 'computed', cp);
    }

    let classProperties = {};

    collapsedKeys.forEach((key, i) => {
      let shouldObserve = observerBools[i];
      let macro = key;
      if (!shouldObserve) {
        key = getOriginalArrayDecorator(key, i);
      }

      let mappedKey = resolveMappedLocation(key, i);

      mappedKeys.push(mappedKey);
      if (shouldObserve) {
        classProperties[`key${i}DidChange`] = observer(mappedKey, rewriteComputed);
      } else {
        let obsKeys = flattenKeys([macro]).map(k => 'context.' + k);

        if (obsKeys.length > 0) {
          classProperties[`key${i}DidChange`] = observer(...obsKeys, function() {
            once(null, () => {
              let { context } = this;

              this.set(mappedKey, getValue({ context, macro, key: null }));
            });
          });
        }
      }
    });

    function setNonStrings(propertyInstance) {
      let { key, context } = propertyInstance;
      let properties = collapsedKeys.reduce((properties, macro, i) => {
        if (typeof macro !== 'string') {
          properties[i.toString()] = getValue({ context, macro, key });
        }
        return properties;
      }, {});

      setProperties(propertyInstance.nonStrings, properties);
    }

    let ObserverClass = BaseClass.extend(classProperties, {
      // can't use rewriteComputed directly, maybe a bug
      // https://github.com/emberjs/ember.js/issues/15246
      onInit: on('init', function() {
        setNonStrings(this);
        rewriteComputed.call(this);
      })
    });

    let cp = computed(...flattenKeys(keys), function(key) {
      let propertyInstance = findOrCreatePropertyInstance(this, ObserverClass, key, cp);

      return get(propertyInstance, 'computed');
    }).readOnly();

    return cp;
  };
}
